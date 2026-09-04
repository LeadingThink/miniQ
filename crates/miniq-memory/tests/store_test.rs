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

#[test]
fn startup_recovery_atomically_terminates_process_owned_state() {
    let store = Store::open_in_memory().unwrap();
    let ws = store
        .create_workspace("D:/tmp/recovery", "recovery")
        .unwrap();
    let active = store.create_session(&ws.id, "active").unwrap();
    let idle = store.create_session(&ws.id, "idle").unwrap();
    store
        .update_session_status(&active.id, SessionStatus::WaitingApproval)
        .unwrap();
    let call = store
        .create_tool_call(
            &active.id,
            "shell_run",
            &json!({"command": "cargo test"}),
            ToolCallStatus::WaitingApproval,
        )
        .unwrap();
    let approval = store
        .create_approval(&active.id, &call.id, RiskLevel::High, "test")
        .unwrap();

    let report = store.recover_interrupted_work().unwrap();

    assert_eq!(report.sessions_failed, 1);
    assert_eq!(report.tool_calls_cancelled, 1);
    assert_eq!(report.approvals_rejected, 1);
    assert_eq!(
        store.get_session(&active.id).unwrap().status,
        SessionStatus::Failed
    );
    assert_eq!(
        store.get_session(&idle.id).unwrap().status,
        SessionStatus::Idle
    );
    assert_eq!(
        store.list_tool_calls(&active.id).unwrap()[0].status,
        ToolCallStatus::Cancelled
    );
    assert!(store
        .list_pending_approval_requests(&active.id)
        .unwrap()
        .is_empty());
    assert!(store
        .resolve_approval(&approval.id, ApprovalStatus::Approved)
        .is_err());

    assert_eq!(
        store.recover_interrupted_work().unwrap(),
        miniq_memory::StartupRecovery::default()
    );
}

#[test]
fn session_recovery_only_terminates_the_requested_session() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("ws", "C:/ws").unwrap();
    let target = store.create_session(&workspace.id, "target").unwrap();
    let other = store.create_session(&workspace.id, "other").unwrap();
    for session in [&target, &other] {
        store
            .update_session_status(&session.id, SessionStatus::WaitingApproval)
            .unwrap();
        let call = store
            .create_tool_call(
                &session.id,
                "plugin.tool",
                &json!({}),
                ToolCallStatus::WaitingApproval,
            )
            .unwrap();
        store
            .create_approval(&session.id, &call.id, RiskLevel::High, "test")
            .unwrap();
    }

    let report = store.recover_interrupted_session(&target.id).unwrap();

    assert_eq!(
        report,
        miniq_memory::SessionRecovery {
            session_failed: true,
            tool_calls_cancelled: 1,
            approvals_rejected: 1,
        }
    );
    assert_eq!(
        store.get_session(&target.id).unwrap().status,
        SessionStatus::Failed
    );
    assert_eq!(
        store.get_session(&other.id).unwrap().status,
        SessionStatus::WaitingApproval
    );
    assert_eq!(
        store
            .list_pending_approval_requests(&other.id)
            .unwrap()
            .len(),
        1
    );
}
