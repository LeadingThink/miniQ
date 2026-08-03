use miniq_protocol::{HealthStatus, RpcError, PROTOCOL_VERSION};
use serde_json::{json, Value};

use super::common::to_value;
use crate::state::AppState;

pub(super) fn health(state: &AppState) -> Result<Value, RpcError> {
    to_value(HealthStatus {
        protocol_version: PROTOCOL_VERSION,
        daemon_version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_secs: state.started.elapsed().as_secs(),
    })
}

pub(super) fn list_tools(state: &AppState) -> Result<Value, RpcError> {
    to_value(json!({ "tools": state.router.specs() }))
}
