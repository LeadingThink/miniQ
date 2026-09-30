//! Slash commands for the rich REPL.

use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::editor::Editor;
use super::{render, Repl};
use crate::client::Client;
use crate::output::terminal_text;

const COMMANDS: &[(&str, &str)] = &[
    ("/help", "show commands and keys"),
    ("/model", "choose this session's model"),
    ("/effort", "choose reasoning effort"),
    (
        "/permissions",
        "approval mode: alwaysAsk | auto | fullAccess",
    ),
    ("/approvals", "alias of /permissions"),
    ("/status", "session, model, mode and queue"),
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
    ("/queue", "list queued messages; /queue rm ID removes one"),
    ("/steer", "steer the running turn with a message"),
    ("/stop", "interrupt the running turn"),
    ("/attach", "attach a file to the next message"),
    ("/clear-attachments", "drop pending attachments"),
    ("/history", "print the session transcript as JSON"),
    ("/mcp", "list MCP servers"),
    ("/skills", "list skills"),
    ("/hooks", "list lifecycle hooks"),
    ("/agents", "list sub-agents of this session"),
    ("/clear", "clear the screen"),
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
  Up/Down history · Ctrl+R search history · Ctrl+L clear screen · Ctrl+G edit in $EDITOR
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
    let session = repl.session.clone();
    match command {
        "/exit" | "/quit" => return Ok(Some(0)),
        "/help" => {
            let mut text = String::from("Commands:\n");
            for (name, description) in COMMANDS {
                text.push_str(&format!("  {name:<20} {description}\n"));
            }
            text.push_str(KEYS);
            repl.emit(&text);
        }
        "/model" | "/effort" => {
            repl.suspend();
            let result = crate::monitor::change_model(client, &session, command, arg).await;
            repl.resume()?;
            result?;
            repl.refresh(client).await;
        }
        "/permissions" | "/approvals" => {
            let mode = match arg {
                "" => {
                    repl.info(&format!(
                        "permissions: {} (Shift+Tab cycles; /permissions alwaysAsk|auto|fullAccess)",
                        repl.mode
                    ));
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
            let id = if arg.is_empty() {
                repl.suspend();
                let picked = crate::selection::session(client, &repl.options).await;
                repl.resume()?;
                match picked? {
                    Some(id) => id,
                    None => return Ok(None),
                }
            } else {
                arg.to_owned()
            };
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
        "/goal" => {
            let current = client
                .call("session.goal.get", json!({"sessionId":session}))
                .await?;
            let current = &current["goal"];
            if arg.is_empty() {
                repl.emit(&terminal_text(&goal_text(current)));
            } else {
                let (goal, status) = match arg {
                    "clear" | "cancel" => (None, "cancelled"),
                    "pause" => (None, "paused"),
                    "resume" => (None, "active"),
                    "done" | "complete" => (None, "completed"),
                    text => (Some(text.to_owned()), "active"),
                };
                let goal = match goal {
                    Some(goal) => goal,
                    None => current["goal"]
                        .as_str()
                        .map(str::to_owned)
                        .context("no goal set; use /goal TEXT")?,
                };
                // Keep an existing token budget; `/goal TEXT` never drops it.
                let params = json!({
                    "sessionId": session,
                    "goal": goal,
                    "status": status,
                    "tokenBudget": current["tokenBudget"],
                });
                client.call("session.goal.update", params).await?;
                repl.info(&format!("Goal {status}."));
            }
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
        "/queue" => {
            if let Some(id) = arg.strip_prefix("rm ").or(arg.strip_prefix("remove ")) {
                client
                    .call("session.queueRemove", json!({"queuedMessageId":id.trim()}))
                    .await?;
                repl.info("Removed from queue.");
                return Ok(None);
            }
            let result = client
                .call("session.queueList", json!({"sessionId":session}))
                .await?;
            let queue = result["queue"]
                .as_array()
                .or(result.as_array())
                .cloned()
                .unwrap_or_default();
            repl.queue = queue.clone();
            if queue.is_empty() {
                repl.info("Queue is empty.");
            }
            for item in queue {
                let content = item["content"]
                    .as_str()
                    .or(item["message"]["content"].as_str())
                    .unwrap_or("");
                let line = format!(
                    "{}  {}",
                    item["id"].as_str().unwrap_or("?"),
                    render::truncate(&content.replace('\n', " "), 100)
                );
                repl.emit(&terminal_text(&line));
            }
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
        "/history" => {
            let result = client
                .call("session.history", json!({"sessionId":session}))
                .await?;
            let text = serde_json::to_string_pretty(&result)?;
            repl.emit(&terminal_text(&text));
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
        "/agents" => {
            let result = client
                .call("agent.list", json!({"sessionId":session}))
                .await?;
            list_names(repl, &result, &["agents"], "agents");
        }
        "/clear" => {
            editor.clear();
            let mut out = std::io::stdout();
            let _ = crossterm::execute!(
                out,
                crossterm::terminal::Clear(crossterm::terminal::ClearType::All),
                crossterm::cursor::MoveTo(0, 0)
            );
            let _ = out.flush();
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

async fn switch(repl: &mut Repl, client: &mut Client, id: &str) -> Result<()> {
    let snapshot = client.call("session.open", json!({"sessionId":id})).await?;
    repl.session = id.to_owned();
    repl.context_percent = None;
    repl.context_stale = true;
    repl.last_answer.clear();
    repl.restore(&snapshot);
    repl.refresh(client).await;
    let title = snapshot["session"]["title"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    repl.info(&format!("Session: {id} {title}"));
    Ok(())
}

/// Copy via OSC 52 (works over SSH) and, when available, the local clipboard tool.
fn copy(text: &str) {
    use base64_lite::encode;
    let _ = write!(
        std::io::stdout(),
        "\x1b]52;c;{}\x07",
        encode(text.as_bytes())
    );
    let _ = std::io::stdout().flush();
    for tool in ["pbcopy", "wl-copy", "xclip -selection clipboard"] {
        let mut parts = tool.split(' ');
        let Some(program) = parts.next() else {
            continue;
        };
        if let Ok(mut child) = std::process::Command::new(program)
            .args(parts)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
            return;
        }
    }
}

mod base64_lite {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }
}

fn goal_text(goal: &Value) -> String {
    let Some(text) = goal["goal"].as_str() else {
        return "No goal. Set one with /goal TEXT (pause/resume/done/clear).".into();
    };
    let mut line = format!(
        "Goal [{}]: {text}",
        goal["status"].as_str().unwrap_or("active")
    );
    if let Some(used) = goal["usedTokens"].as_u64() {
        match goal["tokenBudget"].as_u64() {
            Some(budget) => line.push_str(&format!(" · {used}/{budget} tokens")),
            None => line.push_str(&format!(" · {used} tokens")),
        }
    }
    line
}

fn usage(result: &Value) -> String {
    let calls = result["calls"]
        .as_array()
        .or(result["modelCalls"].as_array())
        .or(result.as_array())
        .cloned()
        .unwrap_or_default();
    let (mut input, mut output, mut cached, mut unknown) = (0u64, 0u64, 0u64, 0usize);
    for call in &calls {
        let usage = if call["response"]["usage"].is_object() {
            &call["response"]["usage"]
        } else {
            &call["usage"]
        };
        if !usage.is_object() {
            unknown += 1;
            continue;
        }
        let field = |names: &[&str]| names.iter().find_map(|n| usage[*n].as_u64()).unwrap_or(0);
        // Exact provider fields: OpenAI chat/responses and Anthropic shapes.
        input += field(&["input_tokens", "prompt_tokens", "inputTokens"]);
        output += field(&["output_tokens", "completion_tokens", "outputTokens"]);
        cached += usage["input_tokens_details"]["cached_tokens"]
            .as_u64()
            .or(usage["prompt_tokens_details"]["cached_tokens"].as_u64())
            .unwrap_or_else(|| field(&["cache_read_input_tokens", "cachedInputTokens"]));
    }
    let mut text = format!(
        "{} model call(s) · input {input} tokens ({cached} cached) · output {output} tokens",
        calls.len()
    );
    if unknown > 0 {
        text.push_str(&format!(" · {unknown} call(s) without usage data"));
    }
    text
}

fn list_hooks(repl: &mut Repl, result: &Value) {
    let hooks = result["hooks"].as_array().cloned().unwrap_or_default();
    let mut text = String::new();
    if result["enabled"] == json!(false) {
        text.push_str("  (hooks feature flag is off)\n");
    }
    if hooks.is_empty() {
        repl.info(&format!("{}No hooks.", text.trim_start()));
        return;
    }
    for hook in hooks {
        let event = hook["event"].as_str().unwrap_or("?");
        let matcher = hook["matcher"].as_str().unwrap_or("*");
        let disabled = if hook["enabled"] == json!(false) {
            " (disabled)"
        } else {
            ""
        };
        let command = hook["command"].as_str().unwrap_or("");
        text.push_str(&format!(
            "  {event} [{matcher}]{disabled}  {}\n",
            render::truncate(command, 100)
        ));
    }
    repl.emit(&terminal_text(&text));
}

fn list_names(repl: &mut Repl, result: &Value, keys: &[&str], label: &str) {
    let items = keys
        .iter()
        .find_map(|k| result[*k].as_array())
        .or(result.as_array())
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        repl.info(&format!("No {label}."));
        return;
    }
    let mut text = String::new();
    for item in items {
        let name = item["name"]
            .as_str()
            .or(item["id"].as_str())
            .or(item.as_str())
            .unwrap_or("?");
        let detail = item["description"]
            .as_str()
            .or(item["status"].as_str())
            .unwrap_or("");
        text.push_str(&format!("  {name}  {}\n", render::truncate(detail, 100)));
    }
    repl.emit(&terminal_text(&text));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64_lite::encode(b""), "");
        assert_eq!(base64_lite::encode(b"f"), "Zg==");
        assert_eq!(base64_lite::encode(b"fo"), "Zm8=");
        assert_eq!(base64_lite::encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn usage_sums_known_calls() {
        let text = usage(&json!({"calls":[
            {"response":{"usage":{"input_tokens":7,"output_tokens":1,"cache_read_input_tokens":4}}},
            {"response":{"usage":{"prompt_tokens":3,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":1}}}},
            {"response":{"usage":null}}
        ]}));
        assert!(text.contains("input 10"));
        assert!(text.contains("output 2"));
        assert!(text.contains("(5 cached)"));
        assert!(text.contains("1 call(s) without usage"));
    }

    #[test]
    fn commands_are_unique_and_include_context_tools() {
        let names: Vec<_> = COMMANDS.iter().map(|c| c.0).collect();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len());
        for name in ["/undo", "/compact", "/context"] {
            assert!(names.contains(&name), "{name}");
        }
    }
}
