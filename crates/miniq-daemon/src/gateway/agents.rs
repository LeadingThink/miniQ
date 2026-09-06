use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentParams {
    session_id: String,
    agent_id: String,
}

pub(super) async fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ListParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    to_value(json!({ "agents": state.agent_tasks.list(&input.session_id).await }))
}

pub(super) async fn action(
    state: &AppState,
    raw: Option<Value>,
    stop: bool,
) -> Result<Value, RpcError> {
    let input: AgentParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let result = if stop {
        state
            .agent_tasks
            .stop(&input.session_id, &input.agent_id)
            .await
    } else {
        state
            .agent_tasks
            .output(&input.session_id, &input.agent_id, false, Duration::ZERO)
            .await
    };
    result.map_err(|error| RpcError::new(ErrorCode::InvalidParams, error.to_string()))
}
