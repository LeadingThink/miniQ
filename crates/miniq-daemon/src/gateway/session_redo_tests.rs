use super::*;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::{Role, ToolCallStatus};
use std::sync::Arc;

fn setup(directory: &Path) -> (AppState, String, PathBuf) {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.to_str().unwrap(), "redo")
        .unwrap();
    let session = store.create_session(&workspace.id, "redo").unwrap();
    store
        .append_message(&session.id, Role::User, "edit file")
        .unwrap();
    let tool = store
        .create_tool_call(
            &session.id,
            "file_write",
            &json!({}),
            None,
            ToolCallStatus::Succeeded,
        )
        .unwrap();
    let path = directory.join("content.txt");
    let backup = directory.join("backup.txt");
    std::fs::write(&backup, "before").unwrap();
    std::fs::write(&path, "after").unwrap();
    store
        .create_checkpoint(
            &session.id,
            &tool.id,
            path.to_str().unwrap(),
            true,
            Some(backup.to_str().unwrap()),
        )
        .unwrap();
    store
        .append_message(&session.id, Role::Assistant, "done")
        .unwrap();
    let mut state = AppState::new(
        store,
        "test".into(),
        Arc::new(MockProvider::text("must not run")),
    );
    state.checkpoints_dir = directory.join("checkpoints");
    (state, session.id, path)
}

#[tokio::test]
async fn undo_and_redo_restore_files_and_records_without_a_model_call() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session, path) = setup(dir.path());
    let original = state.store.list_messages(&session).unwrap();
    super::super::session_context::undo(&state, Some(json!({"sessionId":session}))).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "before");
    assert!(state.store.list_messages(&session).unwrap().is_empty());
    redo(&state, Some(json!({"sessionId":session}))).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
    assert_eq!(
        serde_json::to_value(state.store.list_messages(&session).unwrap()).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(state.store.list_checkpoints(&session).unwrap().len(), 1);
}

#[tokio::test]
async fn redo_conflicting_file_leaves_conversation_and_new_content_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session, path) = setup(dir.path());
    super::super::session_context::undo(&state, Some(json!({"sessionId":session}))).unwrap();
    std::fs::write(&path, "manual edit").unwrap();
    assert!(redo(&state, Some(json!({"sessionId":session})))
        .unwrap_err()
        .message
        .contains("changed after undo"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "manual edit");
    assert!(state.store.list_messages(&session).unwrap().is_empty());
}

#[tokio::test]
async fn redo_requires_an_idle_session() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session, _) = setup(dir.path());
    let _turn = state.begin_turn(&session).unwrap();
    let result = redo(&state, Some(json!({"sessionId":session}))).unwrap_err();
    assert_eq!(result.code, ErrorCode::SessionBusy as i64);
    state.end_turn(&session);
}
