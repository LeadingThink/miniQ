//! Slash commands for the rich REPL.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::editor::Editor;
use super::{render, Repl};
use crate::client::Client;
use crate::output::terminal_text;

#[path = "command_output.rs"]
mod output;
#[cfg(test)]
use output::base64_lite;
use output::{copy, list_hooks, list_names, usage};

const COMMANDS: &[(&str, &str)] = &[
    ("/help", "show commands and keys"),
    ("/commands", "open the command palette"),
    ("/models", "choose this session's model"),
    ("/sessions", "switch to another session"),
    ("/sidebar", "toggle session sidebar"),
    ("/details", "expand or collapse complete tool output"),
    ("/model", "choose this session's model"),
    ("/effort", "choose reasoning effort"),
    (
        "/permissions",
        "approval mode: alwaysAsk | auto | fullAccess",
    ),
    ("/approvals", "alias of /permissions"),
    ("/status", "session, model, mode and queue"),
    (
        "/remote",
        "远程连接设置：开启、关闭、设备名称和状态（这台电脑共用）",
    ),
    ("/new", "start a new session"),
    ("/resume", "switch to another session"),
    ("/fork", "fork this session at the latest message"),
    (
        "/undo",
        "remove the last prompt and its reply, restore edited files",
    ),
    ("/compact", "summarize the conversation now to free context"),
    ("/context", "estimated context window usage"),
    ("/rename", "rename this session"),
    ("/diff", "show files changed in this session"),
    ("/copy", "copy the last answer to the clipboard"),
    ("/init", "ask miniQ to write AGENTS.md"),
    ("/goal", "show or set the session goal"),
    ("/usage", "token usage of recent model calls"),
    ("/cost", "alias of /usage"),
    (
        "/queue",
        "list, update, move, remove or steer queued messages",
    ),
    ("/steer", "steer the running turn with a message"),
    ("/stop", "interrupt the running turn"),
    (
        "/pause",
        "pause the current turn and retain queued follow-ups",
    ),
    ("/resume-turn", "continue a paused turn"),
    (
        "/update",
        "check/install/activate updates; --help lists options",
    ),
    (
        "/manage",
        "run any session, queue, agent or domain management command",
    ),
    ("/attach", "attach a file to the next message"),
    ("/clear-attachments", "drop pending attachments"),
    (
        "/history",
        "readable history; --json preserves the structured page",
    ),
    ("/mcp", "list MCP servers"),
    ("/skills", "list skills"),
    ("/hooks", "list lifecycle hooks"),
    (
        "/agents",
        "list, output, history, message or stop sub-agents",
    ),
    ("/clear", "clear the screen"),
    ("/keybindings", "show the effective key bindings"),
    ("/vim", "toggle vim / emacs editing (saved to cli.json)"),
    (
        "/statusline",
        "show the custom status line command and result",
    ),
    ("/exit", "leave (the session is kept)"),
    ("/quit", "alias of /exit"),
];

pub fn list() -> Vec<(String, String)> {
    COMMANDS
        .iter()
        .map(|(name, description)| ((*name).to_owned(), (*description).to_owned()))
        .collect()
}

const KEYS: &str = "Keys: Enter send (queues while running) · Tab steer running turn / complete · Shift+Enter, Alt+Enter or \\ Enter newline
  Esc interrupt · Ctrl+C clear/interrupt, twice to exit · Ctrl+D exit on empty line · Shift+Tab cycle permissions
  Ctrl+P commands · Ctrl+X then N new / L sessions / M models / B sidebar / D tool details
  PgUp/PgDn or mouse wheel scroll · Ctrl+Home older history · Ctrl+End latest
  Up/Down history · Ctrl+R search history · Ctrl+L redraw screen · Ctrl+G edit in $EDITOR
  Customize keys, editorMode (emacs|vim) and statusLine in cli.json: see /keybindings, /vim, /statusline
  Vim mode: Esc for NORMAL (h j k l w b e 0 ^ $ i a I A o O x X dd D C cc dw cw db d$ yy p P u r G gg)
  @path attaches an existing file (Tab completes paths) · !cmd runs a local shell command, output is not sent";

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
    if super::management::run(repl, client, line).await? {
        return Ok(None);
    }
    let command = match command {
        "/models" => "/model",
        "/sessions" => "/resume",
        other => other,
    };
    let session = repl.session.clone();
    match command {
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
        "/model" | "/effort" => {
            if arg.is_empty() {
                repl.open_picker(
                    client,
                    if command == "/model" {
                        super::picker::Purpose::Models
                    } else {
                        super::picker::Purpose::Effort
                    },
                )
                .await?;
            } else {
                let options = crate::args::ChatOptions {
                    model: (command == "/model").then(|| arg.to_owned()),
                    effort: (command == "/effort").then(|| arg.to_owned()),
                    ..Default::default()
                };
                crate::sessions::update_model(client, &session, &options).await?;
                repl.refresh(client).await;
                repl.notice = format!("Selected {arg}");
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
            let state = client
                .call(
                    "session.approval.update",
                    json!({"sessionId":session,"mode":mode}),
                )
                .await?;
            repl.mode = state["effective"].as_str().unwrap_or(mode).to_owned();
            repl.info(&format!("permissions: {}", repl.mode));
        }
        "/status" => {
            repl.refresh(client).await;
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
            idle(repl)?;
            let id = crate::sessions::prepare(client, &repl.options, None).await?;
            switch(repl, client, &id).await?;
        }
        "/resume" => {
            idle(repl)?;
            if arg.is_empty() {
                repl.open_picker(client, super::picker::Purpose::Sessions)
                    .await?;
                return Ok(None);
            }
            let id = arg.to_owned();
            let id = crate::sessions::prepare(client, &repl.options, Some(&id)).await?;
            switch(repl, client, &id).await?;
        }
        "/undo" => {
            idle(repl)?;
            let result = client
                .call("session.undo", json!({"sessionId":session}))
                .await?;
            let prompt = result["removedMessage"]["content"].as_str().unwrap_or("");
            let restored = result["restoredFiles"].as_array().map_or(0, Vec::len);
            let mut text = format!("Undid the last prompt; restored {restored} file(s).");
            if let Some(failed) = result["failedFiles"].as_array().filter(|f| !f.is_empty()) {
                text.push_str(&format!(" {} file(s) could not be restored.", failed.len()));
            }
            repl.info(&text);
            if !prompt.is_empty() && editor.is_empty() {
                editor.set_buffer(prompt);
            }
            repl.context_stale = true;
        }
        "/compact" => {
            idle(repl)?;
            repl.info("Compacting context…");
            let result = client
                .call("session.compact", json!({"sessionId":session}))
                .await?;
            let before = result["estimatedTokensBefore"].as_u64().unwrap_or(0);
            let after = result["estimatedTokensAfter"].as_u64().unwrap_or(0);
            if result["compacted"] == true {
                repl.info(&format!("Context compacted: ~{before} → ~{after} tokens."));
            } else {
                repl.info("Nothing to compact yet.");
            }
            repl.context_stale = true;
        }
        "/context" => {
            let usage = client
                .call("session.contextUsage", json!({"sessionId":session}))
                .await?;
            let used = usage["estimatedTokens"].as_u64().unwrap_or(0);
            let text = match usage["contextWindowTokens"].as_u64() {
                Some(window) => format!(
                    "Context: ~{used} / {window} tokens ({:.0}%) · auto-compacts near ~{} tokens",
                    usage["percentUsed"].as_f64().unwrap_or(0.0),
                    usage["autoCompactTokens"].as_u64().unwrap_or(0)
                ),
                None => format!("Context: ~{used} tokens (model window unknown)"),
            };
            repl.context_percent = usage["percentUsed"].as_f64();
            repl.info(&text);
        }
        "/fork" => {
            idle(repl)?;
            let snapshot = client
                .call("session.open", json!({"sessionId":session}))
                .await?;
            // The daemon only forks from a durable assistant reply.
            let anchor = snapshot["messages"]
                .as_array()
                .and_then(|m| m.iter().rev().find(|m| m["role"] == "assistant"))
                .and_then(|m| m["id"].as_str())
                .context("nothing to fork yet: no assistant reply in this session")?
                .to_owned();
            let mut params = json!({"sessionId":session,"anchorMessageId":anchor});
            if !arg.is_empty() {
                params["title"] = json!(arg);
            }
            let result = client.call("session.fork", params).await?;
            let id = result["session"]["id"]
                .as_str()
                .or(result["sessionId"].as_str())
                .or(result["id"].as_str())
                .context("daemon did not return the forked session")?
                .to_owned();
            client.scope(&id);
            switch(repl, client, &id).await?;
        }
        "/rename" => {
            if arg.is_empty() {
                bail!("usage: /rename TITLE");
            }
            client
                .call("session.rename", json!({"sessionId":session,"title":arg}))
                .await?;
            repl.info(&format!("Renamed to: {arg}"));
        }
        "/diff" => {
            let result = client
                .call("session.diff", json!({"sessionId":session}))
                .await?;
            let text = render::diff(&result, repl.style);
            if text.trim().is_empty() {
                repl.info("No file changes in this session.");
            } else {
                repl.emit(&text);
            }
        }
        "/copy" => {
            if repl.last_answer.is_empty() {
                bail!("no answer to copy yet");
            }
            let answer = repl.last_answer.clone();
            copy(&answer);
            repl.info(&format!("Copied {} characters.", answer.chars().count()));
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
            let result = client
                .call(
                    "session.modelCalls",
                    json!({"sessionId":session,"limit":100}),
                )
                .await?;
            repl.emit(&usage(&result));
        }
        "/steer" => {
            if arg.is_empty() {
                bail!("usage: /steer MESSAGE");
            }
            let steer = repl.running;
            repl.send(client, arg, steer).await?;
        }
        "/stop" => {
            if repl.running {
                client
                    .call("session.cancel", json!({"sessionId":session}))
                    .await?;
                repl.info("Cancellation requested…");
            } else {
                repl.info("Nothing is running.");
            }
        }
        "/attach" if !arg.is_empty() => {
            let path = PathBuf::from(arg);
            let path = if path.is_absolute() {
                path
            } else {
                repl.working_directory().join(path)
            };
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
        "/mcp" => {
            let result = client.call("mcp.list", json!({})).await?;
            list_names(repl, &result, &["servers", "mcpServers"], "MCP servers");
        }
        "/hooks" => {
            let result = client.call("hooks.list", json!({})).await?;
            list_hooks(repl, &result);
        }
        "/skills" => {
            // Include project skills: scope the listing to this session's workspace.
            let snapshot = client
                .call("session.open", json!({"sessionId":session, "limit": 1}))
                .await?;
            let params = match snapshot["session"]["workspaceId"].as_str() {
                Some(workspace) => json!({"workspaceId": workspace}),
                None => json!({}),
            };
            let result = client.call("skill.list", params).await?;
            list_names(repl, &result, &["skills"], "skills");
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
    let snapshot = client
        .call(
            "session.open",
            json!({"sessionId":id,"includePayloads":true}),
        )
        .await?;
    repl.session = id.to_owned();
    repl.context_percent = None;
    repl.context_stale = true;
    repl.last_answer.clear();
    repl.restore(&snapshot);
    repl.refresh(client).await;
    repl.ui.picker = None;
    repl.ui.scroll = None;
    Ok(())
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
