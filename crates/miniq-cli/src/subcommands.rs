//! Non-interactive management subcommands: mcp, skills, plugins, config, doctor, diff, fork, rename.
//!
//! Every command prints a human-readable table by default and the daemon's JSON with `--json`.
//! Daemon-provided text is untrusted, so human output goes through `terminal_text`.

use std::io::{self, IsTerminal};
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};

use crate::args::{ConfigCommand, McpCommand};
use crate::client::Client;
use crate::output::terminal_text;

fn print_json(value: &Value) -> u8 {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
    0
}

fn text(value: &Value) -> String {
    let raw = match value {
        Value::Null => "-".to_owned(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    terminal_text(&raw).replace(['\n', '\t'], " ")
}

/// Render rows as left-aligned columns separated by two spaces.
pub fn table(headers: &[&str], rows: &[Vec<String>]) -> String {
    let mut widths: Vec<usize> = headers
        .iter()
        .map(|header| header.chars().count())
        .collect();
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    let line = |cells: Vec<&str>| {
        let last = cells.len() - 1;
        cells
            .iter()
            .enumerate()
            .map(|(index, cell)| {
                if index == last {
                    cell.to_string()
                } else {
                    format!("{cell:<width$}", width = widths[index])
                }
            })
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut out = vec![line(headers.to_vec())];
    out.extend(
        rows.iter()
            .map(|row| line(row.iter().map(String::as_str).collect())),
    );
    out.join("\n")
}

// ---------------------------------------------------------------- mcp

pub async fn mcp(client: &mut Client, command: McpCommand) -> Result<u8> {
    match command {
        McpCommand::List { json } => {
            let result = client.call("mcp.list", json!({})).await?;
            if json {
                return Ok(print_json(&result));
            }
            let servers = result["servers"].as_array().cloned().unwrap_or_default();
            if servers.is_empty() {
                println!("No MCP servers. Add one with `miniq mcp add NAME COMMAND [ARGS...]`.");
                return Ok(0);
            }
            let rows = servers
                .iter()
                .map(|server| {
                    let source = match server["pluginName"].as_str() {
                        Some(plugin) => format!("plugin:{}", terminal_text(plugin)),
                        None => text(&server["source"]),
                    };
                    vec![
                        text(&server["name"]),
                        text(&server["status"]),
                        source,
                        command_line(server),
                    ]
                })
                .collect::<Vec<_>>();
            println!("{}", table(&["NAME", "STATUS", "SOURCE", "COMMAND"], &rows));
            Ok(0)
        }
        McpCommand::Get { name, json } => {
            let result = client.call("mcp.list", json!({})).await?;
            let server = result["servers"]
                .as_array()
                .and_then(|servers| {
                    servers
                        .iter()
                        .find(|server| server["name"] == name.as_str())
                })
                .cloned()
                .ok_or_else(|| anyhow!("no MCP server named `{name}`; see `miniq mcp list`"))?;
            if json {
                return Ok(print_json(&server));
            }
            for key in [
                "name",
                "status",
                "source",
                "enabled",
                "pluginName",
                "description",
                "error",
            ] {
                if !server[key].is_null() {
                    println!("{key:<12} {}", text(&server[key]));
                }
            }
            println!("{:<12} {}", "command", command_line(&server));
            if let Some(tools) = server["tools"].as_array() {
                println!("{:<12} {}", "tools", tools.len());
            }
            Ok(0)
        }
        McpCommand::Add {
            name,
            command,
            args,
            env,
            disabled,
        } => {
            let mut entry = json!({"name":name,"command":command,"args":args,"enabled":!disabled});
            if !env.is_empty() {
                let mut vars = Map::new();
                for pair in env {
                    let (key, value) = pair
                        .split_once('=')
                        .ok_or_else(|| anyhow!("--env expects KEY=VALUE, got `{pair}`"))?;
                    vars.insert(key.to_owned(), json!(value));
                }
                entry["env"] = Value::Object(vars);
            }
            let mut servers = user_servers(client).await?;
            let replaced = servers.iter().any(|server| server["name"] == name.as_str());
            servers.retain(|server| server["name"] != name.as_str());
            servers.push(entry);
            client
                .call("mcp.update", json!({"servers":servers}))
                .await?;
            println!(
                "{} MCP server `{}`.",
                if replaced { "Updated" } else { "Added" },
                terminal_text(&name)
            );
            Ok(0)
        }
        McpCommand::Remove { name } => {
            let mut servers = user_servers(client).await?;
            let before = servers.len();
            servers.retain(|server| server["name"] != name.as_str());
            if servers.len() == before {
                bail!("no user MCP server named `{name}` (plugin servers are managed by their plugin)");
            }
            client
                .call("mcp.update", json!({"servers":servers}))
                .await?;
            println!("Removed MCP server `{}`.", terminal_text(&name));
            Ok(0)
        }
    }
}

fn command_line(server: &Value) -> String {
    let mut parts = vec![text(&server["command"])];
    if let Some(args) = server["args"].as_array() {
        parts.extend(args.iter().map(text));
    }
    parts.join(" ")
}

/// User-owned servers in the shape `mcp.update` accepts (plugin servers are excluded).
async fn user_servers(client: &mut Client) -> Result<Vec<Value>> {
    let result = client.call("mcp.list", json!({})).await?;
    Ok(result["servers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|server| server["source"] != "plugin")
        .map(|server| {
            json!({"name":server["name"],"command":server["command"],
            "args":server["args"].as_array().cloned().unwrap_or_default(),
            "enabled":server["enabled"].as_bool().unwrap_or(true)})
        })
        .collect())
}

// ---------------------------------------------------------------- skills / plugins

pub async fn skills(client: &mut Client, json: bool) -> Result<u8> {
    let result = client.call("skill.list", json!({})).await?;
    if json {
        return Ok(print_json(&result));
    }
    let rows = list_rows(
        &result["skills"],
        &["name", "version", "source", "enabled", "description"],
    );
    if rows.is_empty() {
        println!("No skills installed.");
    } else {
        println!(
            "{}",
            table(
                &["NAME", "VERSION", "SOURCE", "ENABLED", "DESCRIPTION"],
                &rows
            )
        );
    }
    Ok(0)
}

pub async fn hooks(client: &mut Client, json: bool) -> Result<u8> {
    let result = client.call("hooks.list", json!({})).await?;
    if json {
        return Ok(print_json(&result));
    }
    let hooks: Vec<Value> = result["hooks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut hook| {
            if hook["matcher"].is_null() {
                hook["matcher"] = json!("*");
            }
            if hook["timeoutSecs"].is_null() {
                hook["timeoutSecs"] = json!(30);
            }
            if hook["enabled"].is_null() {
                hook["enabled"] = json!(true);
            }
            hook
        })
        .collect();
    let rows = list_rows(
        &Value::Array(hooks),
        &["event", "matcher", "timeoutSecs", "enabled", "command"],
    );
    if result["enabled"] == json!(false) {
        println!("Hooks feature flag is off; configured hooks do not run.");
    }
    if rows.is_empty() {
        println!("No hooks configured.");
    } else {
        println!(
            "{}",
            table(
                &["EVENT", "MATCHER", "TIMEOUT", "ENABLED", "COMMAND"],
                &rows
            )
        );
    }
    Ok(0)
}

pub async fn plugins(client: &mut Client, json: bool) -> Result<u8> {
    let result = client.call("plugin.list", json!({})).await?;
    if json {
        return Ok(print_json(&result));
    }
    let rows = list_rows(
        &result["plugins"],
        &["id", "version", "status", "enabled", "description"],
    );
    if rows.is_empty() {
        println!("No plugins installed.");
    } else {
        println!(
            "{}",
            table(
                &["ID", "VERSION", "STATUS", "ENABLED", "DESCRIPTION"],
                &rows
            )
        );
    }
    Ok(0)
}

fn list_rows(items: &Value, keys: &[&str]) -> Vec<Vec<String>> {
    items
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    keys.iter()
                        .map(|key| {
                            let cell = text(&item[*key]);
                            if *key == "description" && cell.chars().count() > 60 {
                                format!("{}…", cell.chars().take(59).collect::<String>())
                            } else {
                                cell
                            }
                        })
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------- config

/// Replace secret-looking string values so settings can be printed safely.
pub fn mask(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, item)| {
                    let lower = key.to_ascii_lowercase();
                    let secret = (lower.contains("key") && !lower.starts_with("has"))
                        || lower.contains("token")
                        || lower.contains("secret")
                        || lower.contains("password");
                    let item = match item {
                        Value::String(text) if secret && !text.is_empty() => json!("****"),
                        other => mask(other),
                    };
                    (key.clone(), item)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(mask).collect()),
        other => other.clone(),
    }
}

fn lookup<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    key.split('.')
        .try_fold(value, |value, part| value.get(part))
}

fn flatten(prefix: &str, value: &Value, out: &mut Vec<(String, String)>) {
    match value {
        Value::Object(object) if !object.is_empty() => {
            for (key, item) in object {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten(&path, item, out);
            }
        }
        other => out.push((prefix.to_owned(), text(other))),
    }
}

pub async fn config(client: &mut Client, command: ConfigCommand) -> Result<u8> {
    let settings = mask(&client.call("settings.get", json!({})).await?);
    match command {
        ConfigCommand::Get { key, json } => {
            let value = match &key {
                Some(key) => lookup(&settings, key)
                    .cloned()
                    .ok_or_else(|| anyhow!("unknown setting `{key}`; run `miniq config get`"))?,
                None => settings,
            };
            if json {
                return Ok(print_json(&value));
            }
            let mut rows = Vec::new();
            flatten(key.as_deref().unwrap_or(""), &value, &mut rows);
            if key.is_some() && !value.is_object() {
                // A single scalar prints bare, like `git config KEY`, so scripts can capture it.
                if let Some((_, value)) = rows.into_iter().next() {
                    println!("{value}");
                }
                return Ok(0);
            }
            for (key, value) in rows {
                if key.is_empty() {
                    println!("{value}");
                } else {
                    println!("{key} = {value}");
                }
            }
            Ok(0)
        }
        ConfigCommand::Set { key, value } => {
            let params = config_update(&settings, &key, &value)?;
            client.call("settings.update", params).await?;
            println!("Set {key}.");
            Ok(0)
        }
    }
}

/// Build a `settings.update` payload changing one key while keeping the rest of its section.
pub fn config_update(settings: &Value, key: &str, value: &str) -> Result<Value> {
    let parse_bool = |value: &str| match value {
        "true" | "on" | "yes" | "1" => Ok(true),
        "false" | "off" | "no" | "0" => Ok(false),
        _ => Err(anyhow!("`{key}` expects true or false")),
    };
    Ok(match key {
        "provider.baseUrl" | "provider.model" | "provider.apiProtocol" => {
            let provider = &settings["provider"];
            let mut update = json!({"baseUrl":provider["baseUrl"],"model":provider["model"],
                "apiProtocol":provider["apiProtocol"]});
            if update["apiProtocol"].is_null() {
                update["apiProtocol"] = json!("auto");
            }
            update[key.trim_start_matches("provider.")] = json!(value);
            if !update["baseUrl"].is_string() || !update["model"].is_string() {
                bail!("configure a provider first with `miniq configure`");
            }
            json!({ "provider": update })
        }
        "approvalMode" => {
            let mode = match value {
                "alwaysAsk" | "always-ask" => "alwaysAsk",
                "auto" => "auto",
                "fullAccess" | "full-access" => "fullAccess",
                _ => bail!("approvalMode must be alwaysAsk, auto or fullAccess"),
            };
            json!({ "approvalMode": mode })
        }
        "remoteAccess.enabled" | "remoteAccess.relayUrl" | "remoteAccess.deviceName" => {
            let remote = &settings["remoteAccess"];
            let mut update = json!({"enabled":remote["enabled"].as_bool().unwrap_or(false),
                "relayUrl":remote["relayUrl"],"deviceName":remote["deviceName"]});
            let field = key.trim_start_matches("remoteAccess.");
            update[field] = if field == "enabled" {
                json!(parse_bool(value)?)
            } else {
                json!(value)
            };
            json!({ "remoteAccess": update })
        }
        "remoteAccess.deviceId" => {
            if value != "reset" {
                bail!(
                    "remoteAccess.deviceId only accepts `reset`, which generates a new device id"
                );
            }
            let remote = &settings["remoteAccess"];
            json!({ "remoteAccess": {"enabled":remote["enabled"].as_bool().unwrap_or(false),
                "relayUrl":remote["relayUrl"],"deviceName":remote["deviceName"],"resetDeviceId":true} })
        }
        "turnEndedCommand" => {
            json!({ "turnEndedCommand": if value.is_empty() { Value::Null } else { json!(value) } })
        }
        "hooks" => {
            let hooks: Value = if value.trim().is_empty() {
                json!([])
            } else {
                serde_json::from_str(value)
                    .map_err(|error| anyhow::anyhow!("hooks must be a JSON array: {error}"))?
            };
            if !hooks.is_array() {
                bail!("hooks must be a JSON array of {{event, matcher?, command, timeoutSecs?, enabled?}}");
            }
            json!({ "hooks": hooks })
        }
        key if key.to_ascii_lowercase().contains("key") => {
            bail!("API keys are set with `miniq configure` and cleared with `miniq logout`")
        }
        _ => bail!("`{key}` cannot be set; see `miniq config --help` for writable keys"),
    })
}

// ---------------------------------------------------------------- doctor

/// Human ✓/✗ report built from the JSON doctor result plus local checks.
pub fn doctor_report(report: &Value, data_dir: &Path) -> u8 {
    let mut checks: Vec<(bool, String)> = Vec::new();
    let daemon = &report["daemon"];
    checks.push((
        daemon.is_object(),
        format!(
            "daemon connection (version {})",
            text(&daemon["daemonVersion"])
        ),
    ));
    let protocol = &daemon["protocolVersion"];
    checks.push((
        *protocol == json!(miniq_protocol::PROTOCOL_VERSION),
        format!(
            "protocol version {} (CLI expects {})",
            text(protocol),
            miniq_protocol::PROTOCOL_VERSION
        ),
    ));
    let data_ok = std::fs::metadata(data_dir)
        .map(|meta| meta.is_dir())
        .unwrap_or(false);
    checks.push((data_ok, format!("data directory {}", data_dir.display())));
    let provider = &report["settings"]["provider"];
    let model_ok = provider["model"].is_string() && provider["hasApiKey"] == true;
    checks.push((
        model_ok,
        if model_ok {
            format!(
                "model {} at {}",
                text(&provider["model"]),
                text(&provider["baseUrl"])
            )
        } else {
            "model not configured; run `miniq configure`".to_owned()
        },
    ));
    let cwd = std::env::current_dir().ok();
    let cwd_ok = cwd
        .as_ref()
        .is_some_and(|path| std::fs::read_dir(path).is_ok());
    checks.push((
        cwd_ok,
        format!(
            "working directory {}",
            cwd.map(|path| path.display().to_string())
                .unwrap_or_else(|| "unavailable".into())
        ),
    ));
    let (path_ok, path_text) = path_miniq();
    checks.push((path_ok, path_text));
    for (name, value) in report["terminalDependencies"]
        .as_object()
        .into_iter()
        .flatten()
    {
        let ok = value.as_bool().unwrap_or(false);
        checks.push((ok, format!("{name} (optional)")));
    }
    for (ok, label) in &checks {
        println!("{} {}", if *ok { "✓" } else { "✗" }, terminal_text(label));
    }
    println!(
        "CLI {}. Use `miniq doctor --json` for the full report.",
        env!("CARGO_PKG_VERSION")
    );
    let required = &checks[..6];
    u8::from(!required.iter().all(|(ok, _)| *ok))
}

fn path_miniq() -> (bool, String) {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join("miniq"))
            .find(|path| path.is_file())
    });
    let Some(path) = found else {
        return (false, "miniq not found on PATH".to_owned());
    };
    let version = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default();
    let current = format!("miniq {}", env!("CARGO_PKG_VERSION"));
    (
        version == current,
        format!(
            "PATH miniq {} ({}){}",
            path.display(),
            if version.is_empty() {
                "unknown version"
            } else {
                &version
            },
            if version == current {
                ""
            } else {
                " differs from this CLI"
            }
        ),
    )
}

// ---------------------------------------------------------------- diff

fn color_enabled() -> bool {
    io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|value| value.is_empty())
}

/// Render the daemon's structured diff as a unified diff.
pub fn unified(diff: &Value, color: bool) -> String {
    let paint = |code: &str, line: String| {
        if color {
            format!("\x1b[{code}m{line}\x1b[0m")
        } else {
            line
        }
    };
    let mut out = Vec::new();
    for file in diff["files"].as_array().into_iter().flatten() {
        let path = terminal_text(file["path"].as_str().unwrap_or("?"));
        let old = if file["oldExists"] == false {
            "/dev/null".to_owned()
        } else {
            format!("a/{path}")
        };
        let new = if file["newExists"] == false {
            "/dev/null".to_owned()
        } else {
            format!("b/{path}")
        };
        out.push(paint("1", format!("diff --git a/{path} b/{path}")));
        if file["binary"] == true {
            out.push(format!("Binary files {old} and {new} differ"));
            continue;
        }
        out.push(paint("1", format!("--- {old}")));
        out.push(paint("1", format!("+++ {new}")));
        for hunk in file["hunks"].as_array().into_iter().flatten() {
            out.push(paint(
                "36",
                format!(
                    "@@ -{},{} +{},{} @@",
                    hunk["oldStart"], hunk["oldLines"], hunk["newStart"], hunk["newLines"]
                ),
            ));
            for line in hunk["lines"].as_array().into_iter().flatten() {
                let content = terminal_text(line["content"].as_str().unwrap_or(""));
                out.push(match line["kind"].as_str() {
                    Some("addition") => paint("32", format!("+{content}")),
                    Some("deletion") => paint("31", format!("-{content}")),
                    _ => format!(" {content}"),
                });
            }
        }
    }
    out.join("\n")
}

pub async fn diff(client: &mut Client, session: &str, json: bool) -> Result<u8> {
    let result = client
        .call("session.diff", json!({"sessionId":session}))
        .await?;
    if json {
        return Ok(print_json(&result));
    }
    let rendered = unified(&result, color_enabled());
    if rendered.is_empty() {
        eprintln!("No file changes in session {}.", terminal_text(session));
    } else {
        println!("{rendered}");
    }
    Ok(0)
}

// ---------------------------------------------------------------- fork / rename

pub async fn fork(
    client: &mut Client,
    session: &str,
    at: Option<String>,
    title: Option<String>,
    json: bool,
) -> Result<u8> {
    let anchor = match at {
        Some(anchor) => anchor,
        None => latest_assistant(client, session).await?,
    };
    let mut params = json!({"sessionId":session,"anchorMessageId":anchor});
    if let Some(title) = title {
        params["title"] = json!(title);
    }
    let result = client.call("session.fork", params).await?;
    if json {
        return Ok(print_json(&result));
    }
    let id = result["id"]
        .as_str()
        .or_else(|| result["session"]["id"].as_str())
        .unwrap_or("?");
    println!("Forked into session {}", terminal_text(id));
    println!("Next: miniq resume {}", terminal_text(id));
    Ok(0)
}

async fn latest_assistant(client: &mut Client, session: &str) -> Result<String> {
    let history = client
        .call("session.history", json!({"sessionId":session,"limit":100}))
        .await
        .context("read session history")?;
    history["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|message| message["role"] == "assistant")
        .and_then(|message| message["id"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            anyhow!("session has no assistant message to fork from; pass --at MESSAGE_ID")
        })
}

pub async fn rename(client: &mut Client, session: &str, title: &str, json: bool) -> Result<u8> {
    let result = client
        .call("session.rename", json!({"sessionId":session,"title":title}))
        .await?;
    if json {
        return Ok(print_json(&result));
    }
    println!(
        "Renamed {} to {}",
        terminal_text(session),
        text(&result["title"])
    );
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unified_diff_marks_changes_and_colors_only_on_request() {
        let diff = json!({"files":[{"path":"a.txt","oldExists":true,"newExists":true,"binary":false,
            "hunks":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":2,"lines":[
                {"kind":"context","content":"same"},{"kind":"deletion","content":"old\u{1b}[2J"},
                {"kind":"addition","content":"new"}]}]},
            {"path":"new.bin","oldExists":false,"newExists":true,"binary":true,"hunks":[]}]});
        let plain = unified(&diff, false);
        assert!(plain.contains("--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,2 @@\n same\n-old[2J\n+new"));
        assert!(plain.contains("Binary files /dev/null and b/new.bin differ"));
        assert!(!plain.contains('\x1b'));
        assert!(unified(&diff, true).contains("\x1b[32m+new\x1b[0m"));
    }

    #[test]
    fn config_masks_secrets_and_builds_section_updates() {
        let settings = json!({"provider":{"baseUrl":"u","model":"m","apiProtocol":"auto","hasApiKey":true,"apiKey":"sk-1"},
            "remoteAccess":{"enabled":false,"relayUrl":"r","deviceName":"d","token":"t"}});
        let masked = mask(&settings);
        assert_eq!(masked["provider"]["apiKey"], "****");
        assert_eq!(masked["provider"]["hasApiKey"], true);
        assert_eq!(masked["remoteAccess"]["token"], "****");
        assert_eq!(
            config_update(&settings, "provider.model", "x").unwrap(),
            json!({"provider":{"baseUrl":"u","model":"x","apiProtocol":"auto"}})
        );
        assert_eq!(
            config_update(&settings, "remoteAccess.enabled", "true").unwrap()["remoteAccess"],
            json!({"enabled":true,"relayUrl":"r","deviceName":"d"})
        );
        assert_eq!(
            config_update(&settings, "remoteAccess.deviceId", "reset").unwrap()["remoteAccess"],
            json!({"enabled":false,"relayUrl":"r","deviceName":"d","resetDeviceId":true})
        );
        assert!(config_update(&settings, "remoteAccess.deviceId", "desktop-x").is_err());
        assert_eq!(
            config_update(&settings, "approvalMode", "full-access").unwrap()["approvalMode"],
            "fullAccess"
        );
        assert!(config_update(&settings, "approvalMode", "sometimes").is_err());
        assert!(config_update(&settings, "provider.apiKey", "sk").is_err());
        assert!(config_update(&settings, "unknown", "x").is_err());
    }

    #[test]
    fn config_update_parses_hooks_json_arrays() {
        let settings = json!({});
        assert_eq!(
            config_update(
                &settings,
                "hooks",
                r#"[{"event":"preToolUse","matcher":"shell_run","command":"./check.sh"}]"#
            )
            .unwrap(),
            json!({"hooks":[{"event":"preToolUse","matcher":"shell_run","command":"./check.sh"}]})
        );
        assert_eq!(
            config_update(&settings, "hooks", "").unwrap(),
            json!({"hooks": []})
        );
        assert!(config_update(&settings, "hooks", "{not json").is_err());
        assert!(config_update(&settings, "hooks", r#"{"event":"stop"}"#).is_err());
    }

    #[test]
    fn tables_align_columns() {
        let rendered = table(&["A", "B"], &[vec!["long".into(), "x".into()]]);
        assert_eq!(rendered, "A     B\nlong  x");
    }
}
