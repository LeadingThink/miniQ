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

pub(super) fn shutdown(state: &AppState) -> Result<Value, RpcError> {
    let cancelled_turns = state.cancel_all_turns();
    let shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        shutdown.cancel();
    });
    to_value(json!({
        "accepted": true,
        "cancelledTurns": cancelled_turns,
    }))
}

pub(super) fn list_tools(state: &AppState) -> Result<Value, RpcError> {
    to_value(json!({ "tools": state.router.specs() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_memory::Store;
    use std::sync::Arc;

    #[tokio::test]
    async fn shutdown_cancels_turns_and_signals_server() {
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".into(),
            Arc::new(crate::UnconfiguredProvider),
        );
        let turn = state.begin_turn("session-1").unwrap();

        let result = shutdown(&state).unwrap();

        assert_eq!(result["accepted"], true);
        assert_eq!(result["cancelledTurns"], 1);
        assert!(turn.is_cancelled());
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state.shutdown.cancelled(),
        )
        .await
        .unwrap();
    }
}
