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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEntry {
    #[serde(default)]
    source: Option<String>,
    #[serde(flatten)]
    config: crate::mcp::McpServerConfig,
}

fn user_servers(entries: Vec<UpdateEntry>) -> Vec<crate::mcp::McpServerConfig> {
    entries
        .into_iter()
        .filter(|entry| entry.source.as_deref() != Some("plugin"))
        .map(|entry| entry.config)
        .collect()
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: UpdateParams = params(raw)?;
    let servers = user_servers(input.servers);
    validate_servers(&servers)?;
    let mut settings = state.settings.lock().unwrap().clone();
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
        let servers = user_servers(input.servers);
        let names = servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, vec!["mine", "plain"]);
        assert!(servers.iter().all(|s| s.enabled));
    }
}
