use super::*;
use miniq_protocol::{AssistantMessageKind, HistoryParams, Message, Role};
use serde_json::json;

#[test]
fn phases_survive_reopen_pagination_search_and_fork() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let store = Store::open(&path).unwrap();
    let workspace = store.create_workspace("/tmp/phases", "phases").unwrap();
    let session = store.create_session(&workspace.id, "phases").unwrap();
    store
        .append_message(&session.id, Role::User, "task")
        .unwrap();
    for (id, kind) in [
        ("note", AssistantMessageKind::Commentary),
        ("partial", AssistantMessageKind::Interrupted),
        ("final", AssistantMessageKind::Final),
    ] {
        let message = Message {
            id: id.into(),
            session_id: session.id.clone(),
            role: Role::Assistant,
            assistant_kind: Some(kind),
            content: format!("phase-{id}"),
            created_at: now_iso(),
            attachments: vec![],
            turn_timing: None,
            steered: false,
        };
        store
            .save_context_with_message(&session.id, id, &json!([]), None, Some(&message))
            .unwrap();
    }
    drop(store);
    let store = Store::open(&path).unwrap();
    let messages = store.list_messages(&session.id).unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|m| m.assistant_kind)
            .collect::<Vec<_>>(),
        vec![
            None,
            Some(AssistantMessageKind::Commentary),
            Some(AssistantMessageKind::Interrupted),
            Some(AssistantMessageKind::Final)
        ]
    );
    let input: HistoryParams =
        serde_json::from_value(json!({"sessionId":session.id,"limit":2})).unwrap();
    let page = store.history_page(&input).unwrap();
    assert_eq!(
        page.messages[1].assistant_kind,
        Some(AssistantMessageKind::Final)
    );
    let older = store
        .history_page(&HistoryParams {
            before: page.next_cursor,
            ..input
        })
        .unwrap();
    assert_eq!(
        older.messages[1].assistant_kind,
        Some(AssistantMessageKind::Commentary)
    );
    assert_eq!(
        store.search_messages("phase-note", 10).unwrap()[0].assistant_kind,
        Some(AssistantMessageKind::Commentary)
    );
    let fork = store
        .fork_session(
            &session.id,
            Some("final"),
            None,
            miniq_protocol::SessionForkMode::Branch,
            None,
        )
        .unwrap();
    assert_eq!(
        store
            .list_messages(&fork.id)
            .unwrap()
            .iter()
            .map(|m| m.assistant_kind)
            .collect::<Vec<_>>(),
        messages
            .iter()
            .map(|m| m.assistant_kind)
            .collect::<Vec<_>>()
    );
}
