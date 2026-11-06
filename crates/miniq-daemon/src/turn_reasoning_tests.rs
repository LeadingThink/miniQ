use super::*;
use miniq_models::{mock::MockProvider, ChatDelta};
use std::sync::Arc;

#[tokio::test]
async fn reasoning_streams_before_answer_and_survives_message_persistence() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "thinking")
        .unwrap();
    let session = store.create_session(&workspace.id, "thinking").unwrap();
    store
        .append_message(&session.id, Role::User, "compare")
        .unwrap();
    let provider = Arc::new(MockProvider::new(vec![vec![
        ChatDelta::Reasoning("Compare ".into()),
        ChatDelta::Reasoning("the options".into()),
        ChatDelta::Text("Answer".into()),
    ]]));
    let state = AppState::new(store, "test".into(), provider);
    let mut events = state.events.subscribe();
    assert!(execute_turn(&state, &session.id, CancellationToken::new())
        .await
        .is_ok());
    let mut streamed = String::new();
    let mut saw_answer = false;
    while let Ok(event) = events.try_recv() {
        match event {
            Event::AssistantReasoningDelta { delta, .. } => {
                assert!(!saw_answer);
                streamed.push_str(&delta);
            }
            Event::AssistantDelta { delta, .. } => {
                saw_answer = true;
                assert_eq!(delta, "Answer");
            }
            _ => {}
        }
    }
    assert_eq!(streamed, "Compare the options");
    assert!(saw_answer);
    let messages = state.store.list_messages(&session.id).unwrap();
    let answer = messages.last().unwrap();
    assert_eq!(answer.content, "Answer");
    assert_eq!(answer.reasoning, streamed);
    assert!(state
        .streaming_reasoning
        .lock()
        .unwrap()
        .get(&session.id)
        .is_none());
    assert_eq!(visible_message_to_chat(answer).unwrap().content, "Answer");
}

#[tokio::test]
async fn reasoning_is_preserved_when_stream_ends_without_an_answer() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "thinking")
        .unwrap();
    let session = store.create_session(&workspace.id, "thinking").unwrap();
    store
        .append_message(&session.id, Role::User, "compare")
        .unwrap();
    let provider = Arc::new(MockProvider::new(vec![vec![ChatDelta::Reasoning(
        "Partial thinking".into(),
    )]]));
    let state = AppState::new(store, "test".into(), provider);
    assert!(execute_turn(&state, &session.id, CancellationToken::new())
        .await
        .is_err());
    let messages = state.store.list_messages(&session.id).unwrap();
    let answer = messages.last().unwrap();
    assert_eq!(answer.reasoning, "Partial thinking");
    assert_eq!(
        answer.assistant_kind,
        Some(miniq_protocol::AssistantMessageKind::Interrupted)
    );
    assert!(!answer.content.contains("Partial thinking"));
}
