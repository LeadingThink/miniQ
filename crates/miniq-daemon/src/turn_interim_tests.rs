use super::*;
use miniq_models::{mock::MockProvider, ChatDelta, ToolCallRequest};
use miniq_protocol::AssistantMessageKind;
use serde_json::json;
use std::sync::Arc;

fn read(id: &str, path: &str) -> ChatDelta {
    ChatDelta::ToolCall(ToolCallRequest {
        id: id.into(),
        name: "file_read".into(),
        arguments: json!({"path":path}),
    })
}

fn task_plan(status: &str) -> ChatDelta {
    ChatDelta::ToolCall(ToolCallRequest {
        id: format!("plan-{status}"),
        name: "task_update".into(),
        arguments: json!({"tasks":[{"content":"Read both files","status":status}]}),
    })
}

#[tokio::test]
async fn continued_turn_persists_an_interim_and_only_one_final_answer() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("first.txt"), "first result").unwrap();
    std::fs::write(directory.path().join("second.txt"), "second result").unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "interim")
        .unwrap();
    let session = store.create_session(&workspace.id, "interim").unwrap();
    store
        .append_message(&session.id, Role::User, "Read both files")
        .unwrap();
    let provider = Arc::new(MockProvider::new(vec![
        vec![
            ChatDelta::Text("Reading the first file".into()),
            task_plan("in_progress"),
            read("first", "first.txt"),
        ],
        vec![ChatDelta::Text("All files checked".into())],
        vec![read("second", "second.txt")],
        vec![ChatDelta::Text("Both files are verified".into())],
        vec![task_plan("completed")],
        vec![ChatDelta::Text("Both files are verified".into())],
    ]));
    let state = AppState::new(store, "fixture".into(), provider);
    let mut events = state.events.subscribe();
    let cancel = state.begin_turn(&session.id).unwrap();
    spawn_turn(state.clone(), session.id.clone(), cancel, None);
    let emitted = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut messages = Vec::new();
        loop {
            match events.recv().await.unwrap() {
                Event::MessageCreated { message, .. } => messages.push(message),
                Event::TurnCompleted { .. } => break messages,
                Event::TurnFailed { error, .. } => panic!("{error}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let stored = state.store.list_messages(&session.id).unwrap();
    for messages in [&stored, &emitted] {
        let interim = messages
            .iter()
            .find(|m| m.content == "All files checked")
            .unwrap();
        assert_eq!(interim.assistant_kind, Some(AssistantMessageKind::Interim));
        assert_eq!(
            messages
                .iter()
                .filter(|m| m.assistant_kind == Some(AssistantMessageKind::Final))
                .count(),
            1
        );
        let final_answer = messages.last().unwrap();
        assert_eq!(final_answer.content, "Both files are verified");
        assert_ne!(interim.id, final_answer.id);
        let progress = messages
            .iter()
            .find(|m| m.content == "Reading the first file")
            .unwrap();
        assert_eq!(
            progress.assistant_kind,
            Some(AssistantMessageKind::Commentary)
        );
    }
    let calls = state.store.list_tool_calls(&session.id).unwrap();
    assert_eq!(calls.len(), 4, "completed work must not be replayed");
    assert_eq!(
        state.store.last_turn_outcome(&session.id).unwrap().unwrap()["status"],
        "completed"
    );
}
