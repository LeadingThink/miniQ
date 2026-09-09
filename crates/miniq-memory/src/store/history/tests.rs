use super::*;
use miniq_protocol::{Role, ToolCallStatus};
use serde_json::json;

fn input(session: &str) -> HistoryParams {
    serde_json::from_value(json!({"sessionId":session,"limit":3})).unwrap()
}

#[test]
fn pages_tied_timestamps_without_gaps_and_defers_large_payloads() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace("/tmp/history-tests", "history")
        .unwrap();
    let session = store.create_session(&workspace.id, "history").unwrap();
    for i in 0..7 {
        store
            .append_message(&session.id, Role::User, &format!("message {i}"))
            .unwrap();
        let call = store
            .create_tool_call(
                &session.id,
                "shell_run",
                &json!({"command":"inspect"}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        store
            .finish_tool_call(
                &call.id,
                ToolCallStatus::Succeeded,
                Some(&json!({"stdout":"large".repeat(100_000)})),
            )
            .unwrap();
    }
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE messages SET created_at = '2026-09-07T00:00:00Z'",
            [],
        )
        .unwrap();
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE tool_calls SET created_at = '2026-09-07T00:00:00Z'",
            [],
        )
        .unwrap();
    let mut request = input(&session.id);
    let mut ids = std::collections::HashSet::new();
    loop {
        let page = store.history_page(&request).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() < 4096);
        for message in page.messages {
            assert!(ids.insert(message.id));
        }
        for tool in page.tool_calls {
            assert!(tool.payload_deferred);
            assert!(tool.call.input.is_null());
            assert!(tool.call.output.is_none());
            assert!(ids.insert(tool.call.id));
        }
        request.before = page.next_cursor;
        if request.before.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 14);
    request.include_payloads = true;
    request.limit = 100;
    assert!(store
        .history_page(&request)
        .unwrap()
        .tool_calls
        .iter()
        .all(|call| call.call.output.is_some() && !call.payload_deferred));
}

#[test]
fn searches_unloaded_tool_bodies_without_returning_them_or_other_sessions() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace("/tmp/history-search", "history")
        .unwrap();
    let session = store.create_session(&workspace.id, "history").unwrap();
    let other = store.create_session(&workspace.id, "other").unwrap();
    for id in [&session.id, &other.id] {
        let call = store
            .create_tool_call(id, "shell_run", &json!({}), None, ToolCallStatus::Running)
            .unwrap();
        store
            .finish_tool_call(
                &call.id,
                ToolCallStatus::Failed,
                Some(&json!({"stdout":"Search NEEDLE 中文"})),
            )
            .unwrap();
    }
    let mut request = input(&session.id);
    request.query = "needle 中文".into();
    request.filter = miniq_protocol::HistoryFilter::Errors;
    let page = store.history_page(&request).unwrap();
    assert_eq!(page.tool_calls.len(), 1);
    assert_eq!(page.tool_calls[0].call.session_id, session.id);
    assert!(page.tool_calls[0].call.output.is_none());
    request.query = "missing".into();
    assert!(store.history_page(&request).unwrap().tool_calls.is_empty());
}

#[test]
fn child_history_filters_are_owned_paginated_and_keep_large_payloads_deferred() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace("/tmp/child-history", "test")
        .unwrap();
    let session = store.create_session(&workspace.id, "first").unwrap();
    let other = store.create_session(&workspace.id, "other").unwrap();
    for (id, session_id) in [
        ("child-a", &session.id),
        ("child-b", &session.id),
        ("child-other", &other.id),
    ] {
        store
            .create_agent_task(&crate::AgentTaskRow {
                id: id.into(),
                session_id: session_id.into(),
                name: id.into(),
                parent_id: None,
                created_at: super::super::now_iso(),
                state: json!({}),
            })
            .unwrap();
        for _ in 0..4 {
            store
                .create_tool_call(
                    session_id,
                    "file_read",
                    &json!({"body":"data".repeat(10000)}),
                    Some(id),
                    ToolCallStatus::Succeeded,
                )
                .unwrap();
        }
    }
    store
        .append_message(&session.id, Role::User, "parent prompt")
        .unwrap();
    assert!(store
        .create_tool_call(
            &session.id,
            "file_read",
            &json!({}),
            Some("child-other"),
            ToolCallStatus::Pending
        )
        .is_err());
    let mut input = input(&session.id);
    input.agent_id = Some("child-a".into());
    let first = store.history_page(&input).unwrap();
    assert_eq!(first.tool_calls.len(), 3);
    assert!(first.messages.is_empty());
    assert!(first
        .tool_calls
        .iter()
        .all(|call| call.call.agent_id.as_deref() == Some("child-a") && call.call.input.is_null()));
    input.before = first.next_cursor;
    let second = store.history_page(&input).unwrap();
    assert_eq!(second.tool_calls.len(), 1);
    assert!(second.next_cursor.is_none());
    input.before = None;
    input.agent_id = Some("child-other".into());
    assert!(store.history_page(&input).unwrap().tool_calls.is_empty());
}
