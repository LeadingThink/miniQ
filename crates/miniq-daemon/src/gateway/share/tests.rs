use super::*;
use miniq_memory::Store;
use std::sync::Arc;

#[test]
fn selected_history_spans_multiple_pages_without_internal_messages() {
    let (state, _dir, session, first) = setup();
    let mut request = input(&session, &first);
    for index in 0..240 {
        let message = state
            .store
            .append_message(&session, Role::Assistant, &format!("message {index}"))
            .unwrap();
        if index % 3 == 0 {
            request.message_ids.push(message.id);
        }
        state
            .store
            .append_message(&session, Role::Tool, "private payload")
            .unwrap();
    }
    let snapshot = Snapshot::build(&state, &request, "scope".into()).unwrap();
    let messages = snapshot.payload["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 81);
    assert_eq!(messages[0]["content"], "Delivered result");
    assert_eq!(messages.last().unwrap()["content"], "message 237");
    assert!(!snapshot.payload.to_string().contains("private payload"));
}

#[tokio::test]
async fn limits_uploads_across_connections_without_blocking_health() {
    let (state, _dir, session, message) = setup();
    let _first = state.share_uploads.acquire().await.unwrap();
    let _second = state.share_uploads.acquire().await.unwrap();
    let result = create(&state, Some(json!({"sessionId":session,"id":"a".repeat(32),"title":"test","messageIds":[message],"artifactIds":[],"expiresInDays":30}))).await;
    assert_eq!(result.unwrap_err().code, ErrorCode::SessionBusy as i64);
    assert!(crate::gateway::system::health(&state).is_ok());
}

fn setup() -> (AppState, tempfile::TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(dir.path().to_str().unwrap(), "test")
        .unwrap();
    let session = store.create_session(&workspace.id, "share").unwrap();
    let message = store
        .append_message(&session.id, Role::Assistant, "Delivered result")
        .unwrap();
    let state = AppState::new(
        store,
        "local-only-token".into(),
        Arc::new(crate::UnconfiguredProvider),
    );
    (state, dir, session.id, message.id)
}

fn input(session: &str, message: &str) -> CreateInput {
    CreateInput {
        session_id: session.into(),
        id: "a".repeat(32),
        title: "公开标题".into(),
        message_ids: vec![message.into()],
        artifact_ids: vec![],
        expires_in_days: 30,
    }
}

#[test]
fn shares_only_selected_visible_messages_and_explicit_files() {
    let (state, dir, session, message) = setup();
    let secret = state
        .store
        .append_message(&session, Role::System, "private system prompt")
        .unwrap();
    let tool = state
        .store
        .append_message(&session, Role::Tool, "private tool data")
        .unwrap();
    state
        .store
        .append_message(&session, Role::User, "unselected private text")
        .unwrap();
    let mut request = input(&session, &message);
    let snapshot = Snapshot::build(&state, &request, "scope".into()).unwrap();
    let raw = snapshot.payload.to_string();
    assert!(!raw.contains("private"));
    assert!(!raw.contains("local-only-token"));
    assert!(!raw.contains("sessionId"));
    assert_eq!(snapshot.payload["messages"].as_array().unwrap().len(), 1);
    request.message_ids = vec![secret.id];
    assert!(Snapshot::build(&state, &request, "scope".into()).is_err());
    request.message_ids = vec![tool.id];
    assert!(Snapshot::build(&state, &request, "scope".into()).is_err());
    request.message_ids = vec![message];
    let path = dir.path().join("result.md");
    std::fs::write(&path, "complete shared result").unwrap();
    let artifact = state
        .store
        .create_artifact(&session, path.to_str().unwrap(), "document", "Report")
        .unwrap();
    request.artifact_ids.push(artifact.id);
    let snapshot = Snapshot::build(&state, &request, "scope".into()).unwrap();
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.payload["files"][0]["name"], "result.md");
    assert!(!snapshot
        .payload
        .to_string()
        .contains(dir.path().to_str().unwrap()));
}

#[test]
fn rejects_cross_session_and_outside_workspace_artifacts() {
    let (state, dir, session, message) = setup();
    let workspace = state
        .store
        .create_workspace(dir.path().to_str().unwrap(), "other")
        .unwrap();
    let other = state.store.create_session(&workspace.id, "other").unwrap();
    let foreign = state
        .store
        .append_message(&other.id, Role::User, "foreign message")
        .unwrap();
    assert!(Snapshot::build(&state, &input(&session, &foreign.id), "scope".into()).is_err());
    let outside = tempfile::NamedTempFile::new().unwrap();
    let artifact = state
        .store
        .create_artifact(
            &session,
            outside.path().to_str().unwrap(),
            "file",
            "Outside",
        )
        .unwrap();
    let mut request = input(&session, &message);
    request.artifact_ids = vec![artifact.id];
    assert!(Snapshot::build(&state, &request, "scope".into()).is_err());
}

#[test]
fn idempotent_snapshot_and_only_oneapi_credentials_are_used() {
    let (state, _dir, session, message) = setup();
    let request = input(&session, &message);
    assert_eq!(
        Snapshot::build(&state, &request, "scope".into())
            .unwrap()
            .payload,
        Snapshot::build(&state, &request, "scope".into())
            .unwrap()
            .payload
    );
    state.settings.lock().unwrap().provider = Some(miniq_models::ProviderConfig {
        base_url: "https://another-provider.test/v1".into(),
        api_key: "private-key".into(),
        model: "text".into(),
        api_protocol: Default::default(),
        reasoning_effort: None,
    });
    assert!(connection(&state, &session).is_err());
    assert!(!valid_id("../secret"));
    assert!(!valid_id(&"A".repeat(32)));
}
