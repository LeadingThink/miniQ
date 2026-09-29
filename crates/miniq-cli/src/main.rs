mod args;
mod bridge;
mod client;
mod listing;
mod monitor;
mod onboarding;
mod output;
mod schema;
mod selection;
mod sessions;
mod subcommands;
mod updater;

use anyhow::{bail, Context, Result};
use clap::{CommandFactory, Parser};
use serde_json::{json, Value};
use std::io::{self, IsTerminal, Read};
use std::process::ExitCode;

use args::{Cli, Commands, ExecArgs, ExecCommand, OutputFormat};
use client::Client;
use output::{progress, Output};

#[tokio::main]
async fn main() -> ExitCode {
    let mut cli = Cli::parse();
    if cli.print && cli.command.is_some() {
        eprintln!("miniq: --print runs a prompt; it cannot be combined with a subcommand");
        return ExitCode::from(1);
    }
    if cli.print {
        cli.print = false;
        cli.command = Some(Commands::Exec(ExecArgs {
            prompt: cli.prompt.take(),
            output_format: cli.output_format,
            output_schema: cli.output_schema.take(),
            ..ExecArgs::default()
        }));
    }
    let json_output = match &cli.command {
        Some(Commands::Exec(exec)) => exec.format() != OutputFormat::Text,
        Some(Commands::Watch { json, .. }) => *json,
        _ => false,
    };
    match run(cli).await {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            if json_output {
                println!(
                    "{}",
                    json!({"type":"cli_error", "exitCode":1,"error":format!("{error:#}")})
                );
            }
            progress(&format!("miniq: {error:#}"));
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<u8> {
    if let Some(Commands::Completions { shell }) = cli.command {
        clap_complete::generate(shell, &mut Cli::command(), "miniq", &mut io::stdout());
        return Ok(0);
    }
    if let Some(Commands::Update { check }) = cli.command {
        return updater::run(check).await;
    }
    if cli.continue_last && cli.command.is_some() {
        bail!("--continue resumes interactively; use `miniq exec --resume-last` for scripts");
    }
    if cli.command.is_none() || matches!(&cli.command, Some(Commands::Resume { .. })) {
        require_terminal()?;
    }
    let directory = cli.data_dir.clone().unwrap_or_else(miniq_local::data_dir);
    let mut client = client::ensure(&directory, cli.daemon_path.as_deref(), cli.no_start).await?;
    let result = match cli.command {
        Some(Commands::Bridge) => {
            bridge::run(client).await?;
            return Ok(0);
        }
        Some(Commands::Exec(exec)) => return execute(&mut client, &cli.chat, exec).await,
        Some(Commands::Resume { session, last, prompt }) => {
            let id = match session {
                Some(id) => id,
                None if last => sessions::last(&mut client, &cli.chat).await?,
                None => match selection::session(&mut client, &cli.chat).await? {
                    Some(id) => id, None => return Ok(0),
                },
            };
            if !onboarding::ensure(&mut client, true).await? { return Ok(0); }
            let id = sessions::prepare(&mut client, &cli.chat, Some(&id)).await?;
            apply_approval(&mut client, &cli.chat, &id).await?;
            return monitor::interactive(&mut client, &id, prompt, &cli.chat).await;
        }
        Some(Commands::Sessions { all, json }) => {
            let result = sessions::list(&mut client, &cli.chat, all).await?;
            if json || !io::stdout().is_terminal() {
                result
            } else {
                print!("{}", listing::render(&result, all, time::OffsetDateTime::now_utc()));
                return Ok(0);
            }
        }
        Some(Commands::History { session, limit, before }) => client.call("session.history",
            json!({"sessionId":session,"limit":limit,"before":before.map(|value| serde_json::from_str::<Value>(&value)).transpose()?,"includePayloads":true})).await?,
        Some(Commands::Watch { session, json }) => {
            client.scope(&session);
            let snapshot = client.call("session.open", json!({"sessionId":session})).await?;
            let mut output = Output::new(json);
            let code = monitor::wait(&mut client, &session, false, false, &mut output, Some(snapshot)).await?;
            output.finish(&session, code, None);
            return Ok(code);
        }
        Some(Commands::Cancel { session }) => client.call("session.cancel", json!({"sessionId":session})).await?,
        Some(Commands::Configure { base_url, model }) => match onboarding::configure(&mut client, base_url.as_deref(), model.as_deref(), cli.chat.protocol.as_deref()).await? {
            Some(settings) => settings, None => return Ok(0),
        },
        Some(Commands::Models { model }) => match model {
            Some(model) => client.call("model.describe", json!({"model":model,"apiProtocol":cli.chat.protocol.unwrap_or_else(|| "auto".into())})).await?,
            None => client.call("model.list", json!({})).await?,
        },
        Some(Commands::Doctor { json }) => {
            let report = doctor(&mut client).await?;
            if json || !io::stdout().is_terminal() {
                report
            } else {
                return Ok(subcommands::doctor_report(&report, &directory));
            }
        }
        Some(Commands::Mcp { command }) => return subcommands::mcp(&mut client, command).await,
        Some(Commands::Skills { command: args::ListCommand::List { json } }) => return subcommands::skills(&mut client, json).await,
        Some(Commands::Plugins { command: args::ListCommand::List { json } }) => return subcommands::plugins(&mut client, json).await,
        Some(Commands::Config { command }) => return subcommands::config(&mut client, command).await,
        Some(Commands::Diff { session, json }) => {
            let session = match session { Some(id) => id, None => sessions::last(&mut client, &cli.chat).await? };
            return subcommands::diff(&mut client, &session, json).await;
        }
        Some(Commands::Fork { session, at, title, json }) => return subcommands::fork(&mut client, &session, at, title, json).await,
        Some(Commands::Rename { session, title, json }) => return subcommands::rename(&mut client, &session, &title, json).await,
        Some(Commands::Status) => client.call("settings.get", json!({})).await?,
        Some(Commands::Logout) => {
            let settings = client.call("settings.get", json!({})).await?;
            let provider = &settings["provider"];
            if provider.is_null() { bail!("no provider is configured"); }
            client.call("settings.update", json!({"provider":{"baseUrl":provider["baseUrl"],
                "model":provider["model"],"apiProtocol":provider["apiProtocol"],"clearApiKey":true}})).await?
        }
        Some(Commands::Rpc { method, params }) => {
            let params: Value = if params == "-" { serde_json::from_reader(io::stdin())? } else { serde_json::from_str(&params)? };
            client.call(&method, params).await?
        }
        None => {
            if !onboarding::ensure(&mut client, true).await? { return Ok(0); }
            let session = if cli.continue_last { Some(sessions::last(&mut client, &cli.chat).await?) } else { None };
            let id = sessions::prepare(&mut client, &cli.chat, session.as_deref()).await?;
            apply_approval(&mut client, &cli.chat, &id).await?;
            return monitor::interactive(&mut client, &id, cli.prompt, &cli.chat).await;
        }
        Some(Commands::Completions { .. } | Commands::Update { .. }) => unreachable!(),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(0)
}

fn require_terminal() -> Result<()> {
    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        bail!("interactive chat needs a terminal; use `miniq exec -` for stdin");
    }
    Ok(())
}

fn prompt_from_stdin(prompt: Option<String>) -> Result<String> {
    let mut input = String::new();
    if !io::stdin().is_terminal() {
        io::stdin().read_to_string(&mut input)?;
    }
    let prompt = match prompt.as_deref() {
        Some("-") | None => input,
        Some(prompt) if input.is_empty() => prompt.to_owned(),
        Some(prompt) => format!("{prompt}\n\n[stdin]\n{input}"),
    };
    if prompt.trim().is_empty() {
        bail!("provide a prompt or pipe one to `miniq exec -`");
    }
    Ok(prompt)
}

/// Store an explicit `--approval` choice on the opened session only.
async fn apply_approval(client: &mut Client, options: &args::ChatOptions, id: &str) -> Result<()> {
    if let Some(mode) = options.approval_mode() {
        client
            .call(
                "session.approval.update",
                json!({"sessionId":id,"mode":mode}),
            )
            .await
            .context("set session approval mode")?;
        if mode == "fullAccess" {
            progress("Approval: full access (tools run without confirmation)");
        }
    }
    Ok(())
}

async fn execute(
    client: &mut Client,
    options: &args::ChatOptions,
    mut exec: ExecArgs,
) -> Result<u8> {
    let format = exec.format();
    let mut resume_last = exec.resume_last;
    if let Some(ExecCommand::Resume {
        session,
        prompt,
        last,
    }) = exec.command.take()
    {
        if exec.session.is_some() || exec.resume_last || exec.prompt.is_some() {
            bail!("use either `exec resume ...` or exec's own --session/--resume-last/PROMPT");
        }
        match (session, prompt, last) {
            (Some(prompt), None, true) => exec.prompt = Some(prompt),
            (Some(_), Some(_), true) => bail!("pass either SESSION_ID or --last, not both"),
            (None, prompt, true) => exec.prompt = prompt,
            (Some(session), prompt, false) => {
                exec.session = Some(session);
                exec.prompt = prompt;
            }
            (None, _, false) => bail!("`miniq exec resume` needs SESSION_ID or --last"),
        }
        resume_last = last;
    }
    let schema = exec
        .output_schema
        .as_deref()
        .map(schema::load)
        .transpose()?;
    let mut prompt = prompt_from_stdin(exec.prompt)?;
    if let Some(schema) = &schema {
        prompt.push_str(&schema::instructions(schema));
    }
    sessions::attachments(&options.attachments)?;
    onboarding::ensure(client, false).await?;
    if let Some(path) = &exec.output {
        if path.exists() {
            bail!(
                "output file already exists; choose a new path: {}",
                path.display()
            );
        }
    }
    if resume_last {
        exec.session = Some(sessions::last(client, options).await?);
    }
    // An explicit --approval replaces the default alwaysAsk requirement.
    let explicit = options.approval_mode().is_some();
    if !explicit && !exec.use_configured_permissions {
        sessions::require_unattended_approval(client, exec.session.as_deref()).await?;
    }
    let id = sessions::prepare(client, options, exec.session.as_deref()).await?;
    if explicit {
        apply_approval(client, options, &id).await?;
    } else if !exec.use_configured_permissions {
        sessions::require_unattended_approval(client, Some(&id)).await?;
    }
    progress(&format!("Session: {id}"));
    let mut output = Output::new(format == OutputFormat::StreamJson);
    if let Err(error) = sessions::send(client, &id, &prompt, &options.attachments).await {
        finish(&output, format, &id, 1, Some(&error.to_string()), None);
        progress(&error.to_string());
        return Ok(1);
    }
    let result = monitor::wait(client, &id, false, true, &mut output, None).await;
    let (mut code, mut error) = match result {
        Ok(code) => (code, None),
        Err(error) => (1, Some(error.to_string())),
    };
    let mut structured = None;
    if let (0, Some(schema)) = (code, &schema) {
        match schema::parse(&output.final_text)
            .and_then(|value| schema::validate(schema, &value).map(|()| value))
        {
            Ok(value) => structured = Some(value),
            Err(reason) => {
                code = 1;
                error = Some(format!("output does not match --output-schema: {reason}"));
            }
        }
    }
    if code == 0 {
        if let Some(path) = exec.output {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .with_context(|| format!("create output {}", path.display()))?;
            file.write_all(output.final_text.as_bytes())?;
        }
    }
    finish(
        &output,
        format,
        &id,
        code,
        error.as_deref(),
        structured.as_ref(),
    );
    if let Some(error) = error {
        progress(&error);
    }
    Ok(code)
}

fn finish(
    output: &Output,
    format: OutputFormat,
    id: &str,
    code: u8,
    error: Option<&str>,
    structured: Option<&Value>,
) {
    if format == OutputFormat::Json {
        println!(
            "{}",
            json!({"type":"result","sessionId":id,"exitCode":code,
            "status":if code == 0 {"completed"} else {"incomplete"},
            "text":output.final_text,"structuredOutput":structured,"error":error})
        );
    } else {
        output.finish(id, code, error);
    }
}

async fn doctor(client: &mut Client) -> Result<Value> {
    let health = client.call("daemon.health", json!({})).await?;
    let settings = client.call("settings.get", json!({})).await?;
    let permissions = client
        .call("computer.permissions", json!({}))
        .await
        .unwrap_or_else(|error| json!({"error":error.to_string()}));
    let mut dependencies = serde_json::Map::new();
    for command in ["pdfinfo", "pdftoppm", "git"] {
        let flag = if command == "git" { "--version" } else { "-v" };
        let available = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::process::Command::new(command)
                .arg(flag)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .is_ok_and(|result| result.is_ok_and(|output| output.status.success()));
        dependencies.insert(command.into(), json!(available));
    }
    Ok(
        json!({"cliVersion":env!("CARGO_PKG_VERSION"),"daemon":health,"settings":settings,
        "desktopPermissions":permissions,"terminalDependencies":dependencies,
        "note":"Dependency checks use this terminal's PATH. An already-running desktop daemon may need a different PATH. No restart or permission changes were performed."}),
    )
}
