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
    let mut output = Vec::new();
    for server in servers {
        let mut entry = json!({
            "name": server.name,
            "command": server.command,
            "args": server.args,
            "enabled": server.enabled,
        });
        populate_status(state, &server, input.connect, &mut entry).await;
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
    servers: Vec<crate::mcp::McpServerConfig>,
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: UpdateParams = params(raw)?;
    validate_servers(&input.servers)?;
    let mut settings = state.settings.lock().unwrap().clone();
    settings.mcp_servers = input.servers;
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
