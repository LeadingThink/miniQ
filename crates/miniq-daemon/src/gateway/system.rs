use miniq_protocol::{ErrorCode, HealthStatus, RpcError, PROTOCOL_VERSION};
use serde_json::{json, Value};

use super::common::to_value;
use crate::state::AppState;

pub(super) fn health(state: &AppState) -> Result<Value, RpcError> {
    let mut health = to_value(HealthStatus {
        protocol_version: PROTOCOL_VERSION,
        daemon_version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_secs: state.started.elapsed().as_secs(),
    })?;
    health["capabilities"] = json!({"rejectBusy": true, "visualFiles": true, "idleShutdown": true});
    Ok(health)
}

pub(super) async fn shutdown(state: &AppState) -> Result<Value, RpcError> {
    state.activity.close();
    let cancelled_turns = state.cancel_all_turns();
    let cancelled_agents = state.agent_tasks.cancel_all().await;
    signal_shutdown(state);
    to_value(json!({
        "accepted": true,
        "cancelledTurns": cancelled_turns,
        "cancelledAgents": cancelled_agents,
    }))
}

pub(super) fn shutdown_if_idle(state: &AppState) -> Result<Value, RpcError> {
    state.activity.close_if_idle(|| {
        if state.store.has_queued_messages().map_err(super::common::store_err)? {
            return Err(RpcError::new(ErrorCode::SessionBusy,
                "miniQ has queued messages; wait for them or explicitly remove them before updating"));
        }
        Ok(())
    })?;
    signal_shutdown(state);
    to_value(json!({"accepted": true, "cancelledTurns": 0, "cancelledAgents": 0}))
}

fn signal_shutdown(state: &AppState) {
    let shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        shutdown.cancel();
    });
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
    async fn idle_shutdown_refuses_work_and_queue_then_blocks_new_admission() {
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".into(),
            Arc::new(crate::UnconfiguredProvider),
        );
        let workspace = state.store.create_workspace("/tmp", "fixture").unwrap();
        let session = state
            .store
            .create_session(&workspace.id, "fixture")
            .unwrap();
        let turn = state.begin_turn(&session.id).unwrap();
        assert!(shutdown_if_idle(&state).is_err());
        assert!(!turn.is_cancelled());
        state.end_turn(&session.id);
        let request = state.activity.enter().unwrap();
        assert!(shutdown_if_idle(&state).is_err());
        drop(request);
        let queued = state.store.enqueue_message(&session.id, "next").unwrap();
        assert!(shutdown_if_idle(&state).is_err());
        assert!(!state.shutdown.is_cancelled());
        assert_eq!(
            state.store.list_queued_messages(&session.id).unwrap().len(),
            1
        );
        state.store.remove_queued_message(&queued.id).unwrap();
        let result = shutdown_if_idle(&state).unwrap();
        assert_eq!(result["cancelledTurns"], 0);
        assert_eq!(result["cancelledAgents"], 0);
        assert!(state.begin_turn(&session.id).is_none());
        let response = crate::gateway::dispatch(
            &state,
            miniq_protocol::RpcRequest::new(
                "late",
                "session.sendMessage",
                Some(json!({"sessionId":session.id,
            "message":{"role":"user","content":"late message"}})),
            ),
        )
        .await;
        assert!(response.error.is_some());
        assert!(state.store.list_messages(&session.id).unwrap().is_empty());
        assert!(!state.store.has_queued_messages().unwrap());
    }

    #[tokio::test]
    async fn shutdown_cancels_turns_and_signals_server() {
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            "token".into(),
            Arc::new(crate::UnconfiguredProvider),
        );
        let turn = state.begin_turn("session-1").unwrap();

        let result = shutdown(&state).await.unwrap();

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
