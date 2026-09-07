use super::*;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::{ErrorCode, PlanTask, PlanTaskStatus, Role, RpcRequest};
use std::sync::Arc;

fn setup(store: Store) -> (AppState, String, String) {
    let workspace = store.create_workspace("/tmp", "test").unwrap();
    let a = store.create_session(&workspace.id, "a").unwrap().id;
    let b = store.create_session(&workspace.id, "b").unwrap().id;
    for id in [&a, &b] {
        store
            .update_session_status(id, SessionStatus::Failed)
            .unwrap();
    }
    (
        AppState::new(
            store,
            "test-only".into(),
            Arc::new(MockProvider::text("done")),
        ),
        a,
        b,
    )
}

fn acknowledge(state: &AppState, session_id: &str, updated_at: &str) -> Value {
    acknowledge_failure(
        state,
        Some(json!({"sessionId":session_id,"updatedAt":updated_at})),
    )
    .unwrap()
}

#[tokio::test]
async fn acknowledgement_is_persistent_scoped_and_keeps_history_and_progress() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("miniq.db");
    let (state, a, b) = setup(Store::open(&path).unwrap());
    let failed = state.store.get_session(&a).unwrap();
    state
        .store
        .append_message(&a, Role::Assistant, "Existing task output")
        .unwrap();
    state
        .store
        .append_audit_event(Some(&a), "test_failure", &json!({"error":"decode"}))
        .unwrap();
    state
        .store
        .set_session_plan(
            &a,
            &[PlanTask {
                content: "Unfinished work".into(),
                status: PlanTaskStatus::Pending,
            }],
        )
        .unwrap();
    // append_message can update metadata; acknowledge the actual opened snapshot.
    let opened = super::super::session::open(&state, Some(json!({"sessionId":a}))).unwrap();
    assert_eq!(opened["session"]["status"], "failed");
    assert_eq!(opened["canAcknowledgeFailure"], true);
    let updated_at = opened["session"]["updatedAt"].as_str().unwrap();
    let mut events = state.events.subscribe();
    let request = serde_json::from_value::<RpcRequest>(json!({
        "jsonrpc":"2.0", "id":"ack", "method":"session.acknowledgeFailure",
        "params":{"sessionId":a,"updatedAt":updated_at}
    }))
    .unwrap();
    let response = serde_json::to_value(crate::gateway::dispatch(&state, request).await).unwrap();
    assert_eq!(response["result"]["acknowledged"], true);
    assert_eq!(response["result"]["session"]["status"], "idle");
    assert_eq!(response["result"]["session"]["updatedAt"], updated_at);
    assert!(
        matches!(events.try_recv().unwrap(), Event::SessionStatusChanged {
        session_id, status: SessionStatus::Idle,
    } if session_id == a)
    );
    assert_eq!(acknowledge(&state, &a, updated_at)["acknowledged"], false);
    assert!(events.try_recv().is_err());
    assert_eq!(
        state.store.get_session(&b).unwrap().status,
        SessionStatus::Failed
    );
    assert_eq!(state.store.list_messages(&a).unwrap().len(), 1);
    assert_eq!(state.store.count_audit_events(&a).unwrap(), 1);
    assert_eq!(
        state.store.session_plan(&a).unwrap()[0].status,
        PlanTaskStatus::Pending
    );
    assert_eq!(
        state.store.get_session(&a).unwrap().created_at,
        failed.created_at
    );
    drop(state);
    assert_eq!(
        Store::open(&path).unwrap().get_session(&a).unwrap().status,
        SessionStatus::Idle
    );
}

#[test]
fn stale_acknowledgements_cannot_clear_a_new_failure_or_an_active_turn() {
    let (state, a, _) = setup(Store::open_in_memory().unwrap());
    let old_failure = state.store.get_session(&a).unwrap();
    state
        .store
        .update_session_status(&a, SessionStatus::Failed)
        .unwrap();
    assert_ne!(
        state.store.get_session(&a).unwrap().updated_at,
        old_failure.updated_at
    );
    assert_eq!(
        acknowledge(&state, &a, &old_failure.updated_at)["acknowledged"],
        false
    );
    assert_eq!(
        state.store.get_session(&a).unwrap().status,
        SessionStatus::Failed
    );
    let current = state.store.get_session(&a).unwrap();
    state.begin_turn(&a).unwrap();
    assert_eq!(
        acknowledge(&state, &a, &current.updated_at)["acknowledged"],
        false
    );
    state.end_turn(&a);
    for status in [
        SessionStatus::Running,
        SessionStatus::WaitingApproval,
        SessionStatus::Cancelling,
        SessionStatus::Idle,
    ] {
        state.store.update_session_status(&a, status).unwrap();
        let current = state.store.get_session(&a).unwrap();
        let result = acknowledge(&state, &a, &current.updated_at);
        assert_eq!(result["acknowledged"], false);
        assert_eq!(state.store.get_session(&a).unwrap().status, status);
    }
}

#[test]
fn malformed_or_missing_targets_are_rejected_without_clearing_any_failure() {
    let (state, a, _) = setup(Store::open_in_memory().unwrap());
    for params in [
        json!({"sessionId":a}),
        json!({"sessionId":a,"updatedAt":0}),
        json!({"sessionId":a,"updatedAt":"test","status":"idle"}),
    ] {
        assert_eq!(
            acknowledge_failure(&state, Some(params)).unwrap_err().code,
            ErrorCode::InvalidParams as i64
        );
    }
    assert_eq!(
        acknowledge_failure(
            &state,
            Some(json!({"sessionId":"missing","updatedAt":"test"}))
        )
        .unwrap_err()
        .code,
        ErrorCode::SessionNotFound as i64
    );
    assert_eq!(
        state.store.get_session(&a).unwrap().status,
        SessionStatus::Failed
    );
}
