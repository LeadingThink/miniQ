use super::*;
use miniq_protocol::{Role, ToolCallStatus};
use serde_json::json;

#[test]
fn redo_restores_complete_records_after_database_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("redo.sqlite");
    let store = Store::open(&db).unwrap();
    let workspace = store.create_workspace("/tmp/redo", "redo").unwrap();
    let session = store.create_session(&workspace.id, "redo").unwrap();
    let prompt = store
        .append_message(&session.id, Role::User, "change files")
        .unwrap();
    let tool = store
        .create_tool_call(
            &session.id,
            "file_write",
            &json!({"path":"a"}),
            None,
            ToolCallStatus::Succeeded,
        )
        .unwrap();
    store
        .finish_tool_call(
            &tool.id,
            ToolCallStatus::Succeeded,
            Some(&json!({"result":"complete"})),
        )
        .unwrap();
    store
        .create_checkpoint(&session.id, &tool.id, "/tmp/redo/a", false, None)
        .unwrap();
    store
        .append_message(&session.id, Role::Assistant, "finished")
        .unwrap();
    store.enqueue_message(&session.id, "next task").unwrap();
    let before = capture(&store.conn.lock().unwrap(), &session.id).unwrap();
    store
        .undo_session_to_user_message(&session.id, &prompt.id)
        .unwrap();
    assert!(store.list_messages(&session.id).unwrap().is_empty());
    drop(store);
    let store = Store::open(&db).unwrap();
    let (id, _) = store.redo_candidate(&session.id).unwrap();
    store.restore_redo(&session.id, id).unwrap();
    assert!(capture(&store.conn.lock().unwrap(), &session.id).unwrap() == before);
    assert!(store.redo_candidate(&session.id).is_err());
}

#[test]
fn redo_refuses_new_work_and_preserves_it() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/tmp/conflict", "conflict").unwrap();
    let session = store.create_session(&workspace.id, "conflict").unwrap();
    let prompt = store
        .append_message(&session.id, Role::User, "old prompt")
        .unwrap();
    store
        .undo_session_to_user_message(&session.id, &prompt.id)
        .unwrap();
    let (id, _) = store.redo_candidate(&session.id).unwrap();
    store
        .append_message(&session.id, Role::User, "new prompt")
        .unwrap();
    assert!(store.redo_candidate(&session.id).is_err());
    assert!(store.restore_redo(&session.id, id).is_err());
    assert_eq!(
        store.list_messages(&session.id).unwrap()[0].content,
        "new prompt"
    );
}

#[test]
fn sequential_undos_can_be_redone_in_order_and_incomplete_files_are_blocked() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/tmp/stack", "stack").unwrap();
    let session = store.create_session(&workspace.id, "stack").unwrap();
    let first = store
        .append_message(&session.id, Role::User, "first")
        .unwrap();
    let second = store
        .append_message(&session.id, Role::User, "second")
        .unwrap();
    store
        .undo_session_to_user_message(&session.id, &second.id)
        .unwrap();
    store
        .undo_session_with_file_recovery(&session.id, &first.id)
        .unwrap();
    assert!(store.redo_candidate(&session.id).is_err());
    store.finish_undo_files(&session.id, &json!([])).unwrap();
    let (id, _) = store.redo_candidate(&session.id).unwrap();
    store.restore_redo(&session.id, id).unwrap();
    let (id, _) = store.redo_candidate(&session.id).unwrap();
    store.restore_redo(&session.id, id).unwrap();
    assert_eq!(store.list_messages(&session.id).unwrap().len(), 2);
}
