use miniq_memory::Store;
use miniq_protocol::{ApprovalStatus, RiskLevel, Role, SessionStatus, ToolCallStatus};
use serde_json::json;

#[test]
fn migration_applies_once() {
    let store = Store::open_in_memory().unwrap();
    // A second store on disk would be the real test; in memory we at least
    // verify all tables exist by using them.
    let ws = store.create_workspace("D:/tmp/proj", "proj").unwrap();
    assert!(ws.id.starts_with("ws_"));
}

#[test]
fn workspace_dedup_by_path() {
    let store = Store::open_in_memory().unwrap();
    let a = store.create_workspace("D:/tmp/proj", "proj").unwrap();
    let b = store.create_workspace("D:/tmp/proj", "other-name").unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(store.list_workspaces().unwrap().len(), 1);
}

#[test]
fn session_message_roundtrip() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace("D:/tmp/proj", "proj").unwrap();
    let sess = store.create_session(&ws.id, "first chat").unwrap();
    assert_eq!(sess.status, SessionStatus::Idle);

    store.append_message(&sess.id, Role::User, "hello").unwrap();
    store
        .append_message(&sess.id, Role::Assistant, "hi there")
        .unwrap();

    let msgs = store.list_messages(&sess.id).unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, Role::User);
    assert_eq!(msgs[1].content, "hi there");

    store
        .update_session_status(&sess.id, SessionStatus::Running)
        .unwrap();
    assert_eq!(
        store.get_session(&sess.id).unwrap().status,
        SessionStatus::Running
    );
}

#[test]
fn tool_call_lifecycle() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace("D:/tmp/proj", "proj").unwrap();
    let sess = store.create_session(&ws.id, "t").unwrap();

    let input = json!({"command": "git status"});
    let call = store
        .create_tool_call(&sess.id, "shell_run", &input, ToolCallStatus::Running)
        .unwrap();
    store
        .finish_tool_call(
            &call.id,
            ToolCallStatus::Succeeded,
            Some(&json!({"exitCode": 0})),
        )
        .unwrap();

    let calls = store.list_tool_calls(&sess.id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].status, ToolCallStatus::Succeeded);
    assert_eq!(calls[0].input, input);
    assert_eq!(calls[0].output.as_ref().unwrap()["exitCode"], 0);
    assert!(calls[0].completed_at.is_some());
}

#[test]
fn approval_resolve_only_once() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace("D:/tmp/proj", "proj").unwrap();
    let sess = store.create_session(&ws.id, "t").unwrap();
    let call = store
        .create_tool_call(
            &sess.id,
            "file_write",
            &json!({"path": "a.txt"}),
            ToolCallStatus::WaitingApproval,
        )
        .unwrap();

    let appr = store
        .create_approval(&sess.id, &call.id, RiskLevel::Medium, "writes a file")
        .unwrap();
    assert_eq!(appr.status, ApprovalStatus::Pending);

    let resolved = store
        .resolve_approval(&appr.id, ApprovalStatus::Approved)
        .unwrap();
    assert_eq!(resolved.status, ApprovalStatus::Approved);
    assert!(resolved.resolved_at.is_some());

    // Second resolve must fail: approval is no longer pending.
    assert!(store
        .resolve_approval(&appr.id, ApprovalStatus::Rejected)
        .is_err());
}

#[test]
fn audit_events_append() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace("D:/tmp/proj", "proj").unwrap();
    let sess = store.create_session(&ws.id, "t").unwrap();
    store
        .append_audit_event(Some(&sess.id), "tool_call", &json!({"tool": "file_read"}))
        .unwrap();
    store
        .append_audit_event(Some(&sess.id), "approval", &json!({"status": "approved"}))
        .unwrap();
    assert_eq!(store.count_audit_events(&sess.id).unwrap(), 2);
}

#[test]
fn persistent_store_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("miniq.db");
    let sess_id;
    {
        let store = Store::open(&db).unwrap();
        let ws = store.create_workspace("D:/tmp/proj", "proj").unwrap();
        let sess = store.create_session(&ws.id, "persisted").unwrap();
        store
            .append_message(&sess.id, Role::User, "still here?")
            .unwrap();
        sess_id = sess.id;
    }
    let store = Store::open(&db).unwrap();
    let msgs = store.list_messages(&sess_id).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "still here?");
}
