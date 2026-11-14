use super::*;
use miniq_protocol::{
    AssistantMessageKind, HistoryParams, Message, PastedTextContent, PastedTextItem, Role,
};
use serde_json::json;

#[test]
fn pasted_text_survives_storage_and_queue_drain() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/tmp/pastes", "pastes").unwrap();
    let session = store.create_session(&workspace.id, "pastes").unwrap();
    let pasted = PastedTextContent {
        content: "[粘贴内容 4 字]\n请总结".into(),
        pastes: vec![PastedTextItem {
            placeholder: "[粘贴内容 4 字]".into(),
            text: "测试正文".into(),
            label: None,
        }],
    };

    store
        .append_message_with_pasted_text(
            &session.id,
            Role::User,
            "测试正文\n请总结",
            &[],
            Some(pasted.clone()),
        )
        .unwrap();
    let saved = store.list_messages(&session.id).unwrap();
    assert_eq!(saved[0].pasted_text, Some(pasted.clone()));

    store
        .enqueue_message_with_pasted_text(&session.id, "测试正文", &[], Some(pasted.clone()))
        .unwrap();
    let drained = store.start_queued_message(&session.id).unwrap().unwrap();
    assert_eq!(drained.pasted_text, Some(pasted));
}

#[test]
fn phases_and_reasoning_survive_reopen_pagination_search_and_fork() {
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
        ("interim", AssistantMessageKind::Interim),
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
            pasted_text: None,
            attachments: vec![],
            turn_timing: None,
            steered: false,
            reasoning: format!("thinking-{id}"),
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
            Some(AssistantMessageKind::Interim),
            Some(AssistantMessageKind::Interrupted),
            Some(AssistantMessageKind::Final)
        ]
    );
    let input: HistoryParams =
        serde_json::from_value(json!({"sessionId":session.id,"limit":2})).unwrap();
    let page = store.history_page(&input).unwrap();
    assert_eq!(page.messages[1].reasoning, "thinking-final");
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
    assert_eq!(older.messages[1].reasoning, "thinking-interim");
    assert_eq!(
        older.messages[1].assistant_kind,
        Some(AssistantMessageKind::Interim)
    );
    let visible = store
        .history_page(
            &serde_json::from_value(json!({"sessionId":session.id,"view":"visible"})).unwrap(),
        )
        .unwrap();
    assert!(visible
        .messages
        .iter()
        .any(|message| message.assistant_kind == Some(AssistantMessageKind::Interim)));
    let process = store
        .process_records_page(
            &serde_json::from_value(json!({"sessionId":session.id,"turnId":messages[0].id}))
                .unwrap(),
        )
        .unwrap();
    assert!(process
        .messages
        .iter()
        .all(|message| message.assistant_kind != Some(AssistantMessageKind::Interim)));
    assert_eq!(
        store.search_messages("phase-interim", 10).unwrap()[0].assistant_kind,
        Some(AssistantMessageKind::Interim)
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
        store.search_messages("phase-note", 10).unwrap()[0].reasoning,
        "thinking-note"
    );
    assert_eq!(
        store
            .list_messages(&fork.id)
            .unwrap()
            .iter()
            .map(|m| &m.reasoning)
            .collect::<Vec<_>>(),
        messages.iter().map(|m| &m.reasoning).collect::<Vec<_>>()
    );
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
