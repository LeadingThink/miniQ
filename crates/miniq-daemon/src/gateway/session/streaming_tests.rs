use super::*;
use miniq_models::mock::MockProvider;
use std::sync::Arc;

#[test]
fn reopening_restores_reasoning_and_replays_only_later_deltas() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "thinking")
        .unwrap();
    let session = store.create_session(&workspace.id, "thinking").unwrap();
    let state = AppState::new(store, "test".into(), Arc::new(MockProvider::new(vec![])));
    let emit_reasoning = |delta: &str| {
        state.emit(Event::AssistantReasoningDelta {
            session_id: session.id.clone(),
            message_id: "reply".into(),
            delta: delta.into(),
        });
    };
    emit_reasoning("First part");
    let snapshot = open(&state, Some(json!({"sessionId": session.id}))).unwrap();
    assert_eq!(snapshot["streamingText"], "");
    assert_eq!(snapshot["streamingReasoning"], "First part");
    let cursor = serde_json::from_value(snapshot["eventCursor"].clone()).unwrap();

    emit_reasoning(" second part");
    let replay = state
        .event_journal
        .lock()
        .unwrap()
        .replay(&session.id, &cursor)
        .unwrap();
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0]["type"], "assistant_reasoning_delta");
    assert_eq!(replay[0]["delta"], " second part");
    let reopened = open(&state, Some(json!({"sessionId": session.id}))).unwrap();
    assert_eq!(reopened["streamingReasoning"], "First part second part");

    state.emit(Event::AssistantReasoningReplaced {
        session_id: session.id.clone(),
        message_id: "reply".into(),
        text: String::new(),
    });
    let retried = open(&state, Some(json!({"sessionId": session.id}))).unwrap();
    assert_eq!(retried["streamingReasoning"], "");
}
