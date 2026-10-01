use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::params;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(default)]
    connect: bool,
}

pub(super) async fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ListParams = params(raw)?;
    let servers = state.settings.lock().unwrap().mcp_servers.clone();
    let plugin_servers = state.plugin_mcp_servers();
    let mut output = Vec::new();
    for server in &servers {
        let mut entry = json!({
            "name": server.name,
            "command": server.command,
            "args": server.args,
            "enabled": server.enabled,
            "source": "settings",
        });
        populate_status(state, server, input.connect, &mut entry).await;
        output.push(entry);
    }
    // Plugin servers are read-only here: they follow their plugin's
    // lifecycle and are never written back by `mcp.update`.
    for plugin in &plugin_servers {
        let server = &plugin.config;
        let shadowed = servers.iter().any(|s| s.name == server.name);
        let mut entry = json!({
            "name": server.name,
            "command": server.command,
            "args": server.args,
            "enabled": !shadowed,
            "source": "plugin",
            "pluginId": plugin.plugin_id,
            "pluginName": plugin.plugin_name,
            "description": plugin.description,
            "readOnly": true,
        });
        if shadowed {
            entry["status"] = json!("shadowed");
            entry["error"] = json!("a user-configured server with the same name takes precedence");
        } else {
            populate_status(state, server, input.connect, &mut entry).await;
        }
        output.push(entry);
    }
    Ok(json!({ "servers": output }))
}

async fn populate_status(
    state: &AppState,
    server: &crate::mcp::McpServerConfig,
    connect: bool,
    entry: &mut Value,
) {
    if connect && server.enabled {
        match state.mcp.list_tools(server).await {
            Ok(tools) => {
                entry["status"] = json!("running");
                entry["tools"] = json!(tools);
            }
            Err(error) => {
                entry["status"] = json!("error");
                entry["error"] = json!(error);
            }
        }
    } else {
        entry["status"] = json!(if server.enabled {
            "configured"
        } else {
            "disabled"
        });
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateParams {
    servers: Vec<UpdateEntry>,
}

/// A settings entry as sent by the UI. Entries echoed back from `mcp.list`
/// with `source: "plugin"` are dropped: only user servers are persisted.
/// `mcp.list` never echoes `env` (it may hold secrets), so an entry without
/// an `env` key keeps the stored environment of the same server.
struct UpdateEntry {
    source: Option<String>,
    env_present: bool,
    config: crate::mcp::McpServerConfig,
}

impl<'de> Deserialize<'de> for UpdateEntry {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let source = value
            .get("source")
            .and_then(Value::as_str)
            .map(str::to_string);
        let env_present = value.get("env").is_some_and(|env| !env.is_null());
        let config = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self {
            source,
            env_present,
            config,
        })
    }
}

fn user_servers(entries: Vec<UpdateEntry>) -> Vec<(crate::mcp::McpServerConfig, bool)> {
    entries
        .into_iter()
        .filter(|entry| entry.source.as_deref() != Some("plugin"))
        .map(|entry| (entry.config, entry.env_present))
        .collect()
}

fn preserve_env(
    entries: Vec<(crate::mcp::McpServerConfig, bool)>,
    existing: &[crate::mcp::McpServerConfig],
) -> Vec<crate::mcp::McpServerConfig> {
    entries
        .into_iter()
        .map(|(mut config, env_present)| {
            if !env_present {
                if let Some(old) = existing.iter().find(|s| s.name == config.name) {
                    config.env = old.env.clone();
                }
            }
            config
        })
        .collect()
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: UpdateParams = params(raw)?;
    let mut settings = state.settings.lock().unwrap().clone();
    let servers = preserve_env(user_servers(input.servers), &settings.mcp_servers);
    validate_servers(&servers)?;
    settings.mcp_servers = servers;
    state
        .update_settings(settings)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error))?;
    Ok(json!({ "ok": true }))
}

fn validate_servers(servers: &[crate::mcp::McpServerConfig]) -> Result<(), RpcError> {
    for server in servers {
        if server.name.trim().is_empty() || server.command.trim().is_empty() {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "server name and command must not be empty",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_persists_only_user_servers() {
        let input: UpdateParams = serde_json::from_value(json!({
            "servers": [
                {"name": "mine", "command": "my-server", "source": "settings"},
                {"name": "plain", "command": "plain"},
                {"name": "linear", "command": "npx", "source": "plugin", "pluginId": "dev.linear", "readOnly": true}
            ]
        }))
        .unwrap();
        let servers = preserve_env(user_servers(input.servers), &[]);
        let names = servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, vec!["mine", "plain"]);
        assert!(servers.iter().all(|s| s.enabled));
    }

    #[test]
    fn update_keeps_env_when_omitted_and_replaces_when_sent() {
        let existing: Vec<crate::mcp::McpServerConfig> = serde_json::from_value(json!([
            {"name": "a", "command": "x", "env": {"TOKEN": "secret"}},
            {"name": "b", "command": "y", "env": {"K": "v"}}
        ]))
        .unwrap();
        let input: UpdateParams = serde_json::from_value(json!({
            "servers": [
                {"name": "a", "command": "x"},
                {"name": "b", "command": "y", "env": {}},
                {"name": "c", "command": "z"}
            ]
        }))
        .unwrap();
        let servers = preserve_env(user_servers(input.servers), &existing);
        assert_eq!(
            servers[0].env.get("TOKEN").map(String::as_str),
            Some("secret")
        );
        assert!(servers[1].env.is_empty());
        assert!(servers[2].env.is_empty());
    }
}
