//! Shell and chat share one command parser and the same daemon operations.

use anyhow::{bail, Result};
use clap::Parser;
use serde_json::Value;

use super::Repl;
use crate::{
    args::Commands,
    client::Client,
    manage::{self, ManageCommand},
};

#[derive(Parser)]
struct Invocation {
    #[command(subcommand)]
    command: Commands,
}

fn arguments(line: &str, session: &str) -> Result<Option<Vec<String>>> {
    let (name, arg) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    let arg = arg.trim();
    let mut argv = vec!["miniq".to_owned()];
    match name {
        "/manage" => argv.extend(shell_words::split(arg)?),
        "/pause" | "/resume-turn" => {
            argv.extend([
                "session".into(),
                if name == "/pause" { "pause" } else { "resume" }.into(),
                session.into(),
            ]);
            argv.extend(shell_words::split(arg)?);
        }
        "/goal" => {
            argv.extend(["session".into(), "goal".into()]);
            let status = match arg {
                "pause" => Some("paused"),
                "resume" => Some("active"),
                "clear" | "cancel" => Some("cancelled"),
                "done" | "complete" => Some("completed"),
                _ => None,
            };
            if arg.is_empty() {
                argv.extend(["get".into(), session.into()]);
            } else if let Some(status) = status {
                argv.extend(["status".into(), session.into(), status.into()]);
            } else {
                argv.extend(["set".into(), session.into(), arg.into()]);
            }
        }
        "/queue" | "/agent" | "/agents" => {
            let mut args = shell_words::split(arg)?;
            let action = if args.is_empty() {
                "list".into()
            } else {
                args.remove(0)
            };
            let action = match action.as_str() {
                "rm" => "remove".into(),
                "edit" => "update".into(),
                _ => action,
            };
            argv.extend([
                if name == "/queue" { "queue" } else { "agent" }.into(),
                action,
            ]);
            if !matches!(
                argv.last().map(String::as_str),
                Some("help" | "--help" | "-h")
            ) {
                argv.push(session.into());
            }
            argv.extend(args);
        }
        "/history" => {
            argv.extend(["history".into(), session.into()]);
            argv.extend(shell_words::split(arg)?);
        }
        "/update" => {
            argv.push("update".into());
            argv.extend(shell_words::split(arg)?);
        }
        "/git" | "/terminal" | "/file" | "/tool" | "/review" | "/schedule" | "/memory"
        | "/external" | "/workspace" | "/host" | "/voice" | "/computer" | "/session"
        | "/plugins" | "/approval" => {
            argv.push(name[1..].into());
            if name == "/plugins" && arg.is_empty() {
                argv.push("list".into());
            }
            argv.extend(shell_words::split(arg)?);
        }
        "/skills" if !arg.is_empty() => {
            argv.push("skills".into());
            argv.extend(shell_words::split(arg)?);
        }
        _ => return Ok(None),
    }
    Ok(Some(argv))
}

pub(super) async fn run(repl: &mut Repl, client: &mut Client, line: &str) -> Result<bool> {
    let Some(argv) = arguments(line, &repl.session)? else {
        return Ok(false);
    };
    let command = match Invocation::try_parse_from(argv) {
        Ok(value) => value.command,
        Err(error) if matches!(error.kind(), clap::error::ErrorKind::DisplayHelp) => {
            repl.emit(&error.to_string());
            return Ok(true);
        }
        Err(error) => return Err(error.into()),
    };
    repl.suspend();
    let result = dispatch(client, command).await;
    repl.resume()?;
    result?;
    // Drain replies in the normal event loop before reconnecting if activation
    // replaced the daemon. Installing or choosing Later keeps its connection.
    repl.context_stale = true;
    Ok(true)
}

/// The line-mode fallback uses the same command schema and operations.
pub(crate) async fn run_line(client: &mut Client, session: &str, line: &str) -> Result<bool> {
    let Some(argv) = arguments(line, session)? else {
        return Ok(false);
    };
    let command = match Invocation::try_parse_from(argv) {
        Ok(value) => value.command,
        Err(error) if matches!(error.kind(), clap::error::ErrorKind::DisplayHelp) => {
            crate::output::progress(&error.to_string());
            return Ok(true);
        }
        Err(error) => return Err(error.into()),
    };
    let reconnect = matches!(&command, Commands::Update { check: false, .. });
    let result = dispatch(client, command).await;
    let connected = if reconnect
        && client
            .call("daemon.health", serde_json::json!({}))
            .await
            .is_err()
    {
        client.reconnect(session).await.map(|snapshot| {
            if let Some(reason) = crate::session_outcome::failure(&snapshot) {
                crate::output::progress(&format!("Execution failed: {reason}"));
            } else if crate::session_outcome::paused(&snapshot) {
                crate::output::progress("Turn paused. /resume-turn continues it.");
            }
        })
    } else {
        Ok(())
    };
    result?;
    connected?;
    Ok(true)
}

pub(crate) async fn dispatch(client: &mut Client, command: Commands) -> Result<()> {
    let value: Option<Value> = match command {
        Commands::Session { command } => {
            manage::dispatch(client, ManageCommand::Session(command)).await?;
            None
        }
        Commands::Queue { command } => {
            manage::dispatch(client, ManageCommand::Queue(command)).await?;
            None
        }
        Commands::Agent { command } => {
            manage::dispatch(client, ManageCommand::Agent(command)).await?;
            None
        }
        Commands::Domain(command) => Some(crate::domains::run(client, command).await?),
        Commands::Skills { command } => crate::domains::skills(client, command).await?,
        Commands::Plugins { command } => crate::domains::plugins(client, command).await?,
        Commands::History {
            session,
            limit,
            before,
            json,
        } => {
            let before = before
                .map(|value| serde_json::from_str::<Value>(&value))
                .transpose()?;
            let page = client
                .call(
                    "session.history",
                    serde_json::json!({"sessionId":session,
                "limit":limit,"before":before,"includePayloads":true}),
                )
                .await?;
            manage::print_history(&page, json)?;
            None
        }
        Commands::Update {
            check,
            activate,
            stop_running,
        } => {
            crate::updater::run(check, activate, stop_running, &client.directory).await?;
            None
        }
        _ => bail!("use management commands here; start another chat from the shell"),
    };
    if let Some(value) = value {
        println!(
            "{}",
            crate::output::terminal_text(&serde_json::to_string_pretty(&value)?)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_session_aliases_reuse_the_shell_command_contract() {
        for line in [
            "/pause",
            "/resume-turn",
            "/goal pause",
            "/goal resume",
            "/goal new goal",
            "/queue update q 'complete message with spaces'",
            "/queue move q up",
            "/agents stop a",
            "/history --limit 10",
            "/update --activate",
            "/manage session archive s",
        ] {
            let argv = arguments(line, "s").unwrap().unwrap();
            assert!(
                Invocation::try_parse_from(&argv).is_ok(),
                "{line}: {argv:?}"
            );
        }
        assert!(arguments("/unknown", "s").unwrap().is_none());
        assert!(arguments("/queue update q 'unclosed", "s").is_err());
    }
}
