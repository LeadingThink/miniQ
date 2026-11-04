//! Slash commands for the rich REPL.

use anyhow::{bail, Result};
use serde_json::{json, Value};

use super::editor::Editor;
use super::Repl;
use super::{jobs::Effect, requests::Request};
use crate::client::Client;
use crate::output::terminal_text;

#[path = "command_output.rs"]
mod output;
#[cfg(test)]
use output::base64_lite;
pub(super) async fn copy_text(text: &str) -> Result<Value> {
    output::copy(text).await
}
pub(super) fn usage(value: &Value) -> String {
    output::usage(value)
}

#[path = "command_catalog.rs"]
mod catalog;
pub use catalog::list;
use catalog::{COMMANDS, KEYS};

/// Run one slash command. Returns `Some(code)` to exit.
pub async fn run(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    line: &str,
) -> Result<Option<u8>> {
    let (command, arg) = line
        .split_once(char::is_whitespace)
        .map_or((line, ""), |(c, a)| (c, a.trim()));
    if arg.is_empty() {
        use super::picker::Purpose;
        let panel = match command {
            "/messages" | "/history" => Some(Purpose::Messages),
            "/tools" => Some(Purpose::Tools),
            "/queue" => Some(Purpose::Queue),
            "/agents" => Some(Purpose::Agents),
            "/mcp" => Some(Purpose::Mcp),
            "/skills" => Some(Purpose::Skills),
            "/attachments" => Some(Purpose::Attachments),
            "/drafts" => Some(Purpose::Drafts),
            "/processes" => Some(Purpose::Processes),
            "/diff" => Some(Purpose::Diff),
            "/settings" => Some(Purpose::Settings),
            "/theme" => Some(Purpose::Themes),
            _ => None,
        };
        if let Some(panel) = panel {
            repl.panel(panel);
            return Ok(None);
        }
    }
    if super::management::run(repl, client, line).await? {
        return Ok(None);
    }
    let command = match command {
        "/sessions" => "/resume",
        other => other,
    };
    let session = repl.session.clone();
    match command {
        "/messages" => repl.search_messages(arg, None),
        "/exit" | "/quit" => return Ok(Some(0)),
        "/commands" => {
            repl.open_picker(client, super::picker::Purpose::Commands)
                .await?
        }
        "/sidebar" => repl.ui.sidebar = !repl.ui.sidebar,
        "/details" => {
            repl.ui.expanded = !repl.ui.expanded;
            repl.ui.scroll = None;
        }
        "/help" => {
            let mut text = String::from("Commands:\n");
            for (name, description) in COMMANDS {
                text.push_str(&format!("  {name:<20} {description}\n"));
            }
            text.push_str("  /remote on|off       开启或关闭远程连接\n  /remote name NAME    修改设备名称\n  /remote status       查看连接状态\n");
            text.push_str(KEYS);
            repl.emit(&text);
        }
        "/models" | "/effort" => {
            if arg.is_empty() {
                repl.open_picker(
                    client,
                    if command == "/models" {
                        super::picker::Purpose::Models
                    } else {
                        super::picker::Purpose::Effort
                    },
                )
                .await?;
            } else {
                let options = crate::args::ChatOptions {
                    model: (command == "/models").then(|| arg.to_owned()),
                    effort: (command == "/effort").then(|| arg.to_owned()),
                    ..Default::default()
                };
                repl.request("Updating model", Effect::Model, Request::Model(options));
            }
        }
        "/remote" => {
            repl.suspend();
            let result = crate::remote_settings::run(client, arg).await;
            repl.return_from_command()?;
            result?;
        }
        "/permissions" | "/approvals" => {
            let mode = match arg {
                "" => {
                    repl.open_picker(client, super::picker::Purpose::Permissions)
                        .await?;
                    return Ok(None);
                }
                "ask" | "alwaysAsk" => "alwaysAsk",
                "auto" => "auto",
                "full" | "fullAccess" => "fullAccess",
                other => bail!("unknown mode {other}; use alwaysAsk, auto or fullAccess"),
            };
            repl.rpc(
                "Updating permissions",
                Effect::Permissions,
                "session.approval.update",
                json!({"sessionId":session,"mode":mode}),
            );
        }
        "/status" => {
            let text = format!(
                "Session: {session}\nDirectory: {}\nModel: {} · reasoning: {} · permissions: {}\nStatus: {} · queued: {} · attachments: {}",
                repl.working_directory().display(),
                repl.model,
                repl.effort,
                repl.mode,
                if repl.running { "running" } else { "idle" },
                repl.queue.len(),
                repl.files.len()
            );
            repl.emit(&terminal_text(&text));
        }
        "/new" => {
            repl.switch_request = Some(repl.request(
                "Creating session",
                Effect::Switch,
                Request::New(super::copy_options(&repl.options)),
            ));
        }
        "/resume" => {
            if arg.is_empty() {
                repl.open_picker(client, super::picker::Purpose::Sessions)
                    .await?;
                return Ok(None);
            }
            switch(repl, client, arg).await?;
        }
        "/undo" => {
            idle(repl)?;
            repl.rpc(
                "Undoing last prompt",
                Effect::Undo,
                "session.undo",
                json!({"sessionId":session}),
            );
        }
        "/redo" => {
            idle(repl)?;
            repl.rpc(
                "Restoring undone exchange",
                Effect::Notice("Undone exchange restored".into()),
                "session.redo",
                json!({"sessionId":session}),
            );
        }
        "/compact" => {
            idle(repl)?;
            repl.rpc(
                "Compacting context",
                Effect::Detail("Context compaction".into()),
                "session.compact",
                json!({"sessionId":session}),
            );
        }
        "/context" => {
            repl.rpc(
                "Loading context",
                Effect::Detail("Context usage".into()),
                "session.contextUsage",
                json!({"sessionId":session}),
            );
        }
        "/fork" => {
            repl.switch_request = Some(repl.request(
                "Forking session",
                Effect::Switch,
                Request::Fork {
                    anchor: None,
                    title: arg.into(),
                },
            ));
        }
        "/rename" => {
            if arg.is_empty() {
                repl.form(
                    "Rename session",
                    &repl.statusline.title.clone(),
                    super::forms::FormAction::Rename(session),
                );
                return Ok(None);
            }
            repl.rpc(
                "Renaming session",
                Effect::Notice(format!("Renamed to: {arg}")),
                "session.rename",
                json!({"sessionId":session,"title":arg}),
            );
        }
        "/copy" => {
            if repl.last_answer.is_empty() {
                bail!("no answer to copy yet");
            }
            let answer = repl.last_answer.clone();
            repl.copy_selection(&answer);
        }
        "/init" => {
            let path = repl.working_directory().join("AGENTS.md");
            let prompt = if path.exists() {
                "Review the existing AGENTS.md against the current repository and update it: project overview, build/test/lint commands, code layout, conventions and pitfalls for coding agents. Keep it concise."
            } else {
                "Create an AGENTS.md at the project root for coding agents: project overview, build/test/lint commands, code layout, conventions and pitfalls. Inspect the repository first and keep it concise."
            };
            repl.send(client, prompt, false).await?;
        }
        "/usage" | "/cost" => {
            repl.rpc(
                "Loading usage",
                Effect::Detail("Model usage".into()),
                "session.modelCalls",
                json!({"sessionId":session,"limit":100}),
            );
        }
        "/steer" => {
            if arg.is_empty() {
                bail!("usage: /steer MESSAGE");
            }
            let steer = repl.running;
            repl.send(client, arg, steer).await?;
        }
        "/stop" => {
            if repl.running || repl.processes.active(&repl.session).is_some() {
                repl.cancel(client).await;
            } else {
                repl.info("Nothing is running.");
            }
        }
        "/attach" => {
            if arg.is_empty() {
                repl.form("Attach a file", "", super::forms::FormAction::Attach);
                return Ok(None);
            }
            let path = super::attachments::path(arg, &repl.working_directory());
            let mut files = repl.files.clone();
            files.push(path);
            crate::sessions::attachments(&files)?;
            repl.files = files;
            repl.info(&format!(
                "{} attachment(s) pending for the next message.",
                repl.files.len()
            ));
        }
        "/clear-attachments" => {
            repl.files.clear();
            repl.info("Attachments cleared.");
        }
        "/export" => {
            if arg.is_empty() {
                repl.form(
                    "Export conversation to a new JSON file",
                    "",
                    super::forms::FormAction::Export,
                );
            } else {
                repl.export_session(super::attachments::path(arg, &repl.working_directory()))?;
            }
        }
        "/hooks" => {
            repl.rpc(
                "Loading hooks",
                Effect::Detail("Hooks".into()),
                "hooks.list",
                json!({}),
            );
        }
        "/clear" => {
            editor.clear();
            repl.ui.scroll = None;
            if let Some(terminal) = repl.terminal.as_mut() {
                terminal.terminal.clear()?;
            }
        }
        "/keybindings" => {
            let text = format!(
                "Key bindings (editor mode: {}):\n{}\nOverride in {} under \"keybindings\", e.g. {{\"keybindings\": {{\"submit\": [\"enter\"], \"newline\": \"ctrl+o\"}}}}",
                if editor.vim_enabled() { "vim" } else { "emacs" },
                editor.keymap().describe().trim_end(),
                super::prefs::path(&repl.prefs_dir).display()
            );
            repl.emit(&text);
        }
        "/vim" => {
            let vim = !editor.vim_enabled();
            editor.set_vim(vim);
            let mode = if vim {
                super::prefs::EditorMode::Vim
            } else {
                super::prefs::EditorMode::Emacs
            };
            repl.preferences.editor_mode = mode;
            match super::prefs::save_editor_mode(&repl.prefs_dir, mode) {
                Ok(path) => repl.info(&format!(
                    "Editor mode: {} (saved to {})",
                    mode.as_str(),
                    path.display()
                )),
                Err(error) => repl.error(&format!(
                    "Editor mode: {} for this session; not saved: {error:#}",
                    mode.as_str()
                )),
            }
        }
        "/statusline" => {
            let text = repl
                .statusline
                .describe(&super::prefs::path(&repl.prefs_dir));
            repl.emit(&text);
        }
        _ => repl.info("Unknown or incomplete command. /help lists commands."),
    }
    Ok(None)
}

fn idle(repl: &Repl) -> Result<()> {
    if repl.running {
        bail!("a turn is running; wait or press Esc first");
    }
    Ok(())
}

pub(super) async fn switch(repl: &mut Repl, client: &mut Client, id: &str) -> Result<()> {
    client.watch(id);
    repl.switch_request = Some(repl.request(
        "Opening session",
        Effect::Switch,
        Request::Switch(id.into()),
    ));
    Ok(())
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
