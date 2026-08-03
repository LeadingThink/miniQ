use std::sync::Arc;

use miniq_daemon::gateway;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::{
    Event, ExternalContinuationMode, ExternalProvider, ExternalSessionEvent,
    ExternalSessionMessage, ExternalSessionSnapshot, ExternalSessionSummary, RequestId, Role,
    RpcRequest,
};
use serde_json::json;

#[tokio::test]
async fn imported_history_continues_through_miniq_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(&directory.path().to_string_lossy(), "imported")
        .unwrap();
    let imported = store
        .import_external_session(&workspace.id, &snapshot())
        .unwrap();
    let provider = Arc::new(MockProvider::text("continued response"));
    let state = AppState::new(store, "token".to_owned(), provider.clone());
    let mut events = state.events.subscribe();

    let request = RpcRequest {
        jsonrpc: "2.0".to_owned(),
        id: RequestId::from("send"),
        method: "session.sendMessage".to_owned(),
        params: Some(json!({
            "sessionId": imported.session.id,
            "message": {"role": "user", "content": "continue here"}
        })),
    };
    let response = gateway::dispatch(&state, request).await;
    assert!(response.error.is_none());

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if matches!(events.recv().await.unwrap(), Event::TurnCompleted { .. }) {
                break;
            }
        }
    })
    .await
    .expect("imported continuation completes");

    let requests = provider.requests.lock().unwrap();
    let history: Vec<_> = requests[0]
        .messages
        .iter()
        .map(|message| message.content.as_str())
        .collect();
    assert!(history.ends_with(&["original prompt", "original answer", "continue here"]));
    let persisted = state.store.get_session(&imported.session.id).unwrap();
    assert_eq!(
        persisted.external.unwrap().provider,
        ExternalProvider::Codex
    );
}

fn snapshot() -> ExternalSessionSnapshot {
    ExternalSessionSnapshot {
        summary: ExternalSessionSummary {
            provider: ExternalProvider::Codex,
            external_id: "codex-external".to_owned(),
            title: "Imported session".to_owned(),
            cwd: None,
            source_path: "session.jsonl".to_owned(),
            message_count: 2,
            created_at: Some("2026-01-01T00:00:00Z".to_owned()),
            updated_at: Some("2026-01-01T00:00:02Z".to_owned()),
            continuation_mode: ExternalContinuationMode::RecreateOnly,
        },
        events: vec![
            event("user-event", 0, "original prompt"),
            event("assistant-event", 1, "original answer"),
        ],
        messages: vec![
            message("user-event", Role::User, "original prompt"),
            message("assistant-event", Role::Assistant, "original answer"),
        ],
    }
}

fn event(id: &str, sequence: usize, content: &str) -> ExternalSessionEvent {
    ExternalSessionEvent {
        event_id: id.to_owned(),
        sequence,
        event_type: "message".to_owned(),
        payload: json!({"content": content}),
        occurred_at: Some(format!("2026-01-01T00:00:0{sequence}Z")),
    }
}

fn message(id: &str, role: Role, content: &str) -> ExternalSessionMessage {
    ExternalSessionMessage {
        event_id: id.to_owned(),
        role,
        content: content.to_owned(),
        occurred_at: Some("2026-01-01T00:00:00Z".to_owned()),
    }
}
