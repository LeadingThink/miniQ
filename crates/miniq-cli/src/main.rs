mod args;
mod client;
mod monitor;
mod output;
mod sessions;

use anyhow::{bail, Context, Result};
use clap::{CommandFactory, Parser};
use serde_json::{json, Value};
use std::io::{self, IsTerminal, Read};
use std::process::ExitCode;

use args::{Cli, Commands, ExecArgs};
use client::Client;
use output::{progress, Output};

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let json_output = matches!(
        &cli.command,
        Some(Commands::Exec(ExecArgs { json: true, .. }) | Commands::Watch { json: true, .. })
    );
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
    let directory = cli.data_dir.clone().unwrap_or_else(miniq_local::data_dir);
    let mut client = client::ensure(&directory, cli.daemon_path.as_deref(), cli.no_start).await?;
    let result = match cli.command {
        Some(Commands::Exec(exec)) => return execute(&mut client, &cli.chat, exec).await,
        Some(Commands::Resume { session, last: _, prompt }) => {
            require_terminal()?;
            let id = match session { Some(id) => id, None => sessions::last(&mut client, &cli.chat).await? };
            let id = sessions::prepare(&mut client, &cli.chat, Some(&id)).await?;
            return monitor::interactive(&mut client, &id, prompt, &cli.chat).await;
        }
        Some(Commands::Sessions { all }) => sessions::list(&mut client, &cli.chat, all).await?,
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
        Some(Commands::Configure { base_url, model }) => configure(&mut client, &base_url, &model, cli.chat.protocol.as_deref()).await?,
        Some(Commands::Models { model }) => match model {
            Some(model) => client.call("model.describe", json!({"model":model,"apiProtocol":cli.chat.protocol.unwrap_or_else(|| "auto".into())})).await?,
            None => client.call("model.list", json!({})).await?,
        },
        Some(Commands::Doctor) => doctor(&mut client).await?,
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
            require_terminal()?;
            let id = sessions::prepare(&mut client, &cli.chat, None).await?;
            return monitor::interactive(&mut client, &id, cli.prompt, &cli.chat).await;
        }
        Some(Commands::Completions { .. }) => unreachable!(),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(0)
}

fn require_terminal() -> Result<()> {
    if !io::stdin().is_terminal() {
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

async fn execute(client: &mut Client, options: &args::ChatOptions, exec: ExecArgs) -> Result<u8> {
    let prompt = prompt_from_stdin(exec.prompt)?;
    sessions::attachments(&options.attachments)?;
    if let Some(path) = &exec.output {
        if path.exists() {
            bail!(
                "output file already exists; choose a new path: {}",
                path.display()
            );
        }
    }
    let settings = client.call("settings.get", json!({})).await?;
    if !exec.use_configured_permissions && settings["approvalMode"] != "alwaysAsk" {
        bail!("unattended execution requires shared approvalMode=alwaysAsk, or explicitly --use-configured-permissions. Current mode: {}. Other sessions' permissions were not changed", settings["approvalMode"]);
    }
    let id = sessions::prepare(client, options, exec.session.as_deref()).await?;
    progress(&format!("Session: {id}"));
    let mut output = Output::new(exec.json);
    if let Err(error) = sessions::send(client, &id, &prompt, &options.attachments).await {
        output.finish(&id, 1, Some(&error.to_string()));
        progress(&error.to_string());
        return Ok(1);
    }
    let result = monitor::wait(client, &id, false, true, &mut output, None).await;
    let (code, error) = match result {
        Ok(code) => (code, None),
        Err(error) => (1, Some(error.to_string())),
    };
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
    output.finish(&id, code, error.as_deref());
    if let Some(error) = error {
        progress(&error);
    }
    Ok(code)
}

async fn configure(
    client: &mut Client,
    base_url: &str,
    model: &str,
    protocol: Option<&str>,
) -> Result<Value> {
    let key = match std::env::var("MINIQ_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            require_terminal()?;
            rpassword::prompt_password("API key (hidden; blank keeps existing): ")?
        }
    };
    client
        .call(
            "settings.update",
            json!({"provider":{"baseUrl":base_url,"model":model,
        "apiProtocol":protocol.unwrap_or("auto"),"apiKey":key}}),
        )
        .await
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
