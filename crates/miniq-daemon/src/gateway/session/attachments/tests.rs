use super::*;
use crate::state::AppState;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::{Event, Role, SessionStatus};
use serde_json::{json, Value};
use std::sync::Arc;

fn fixture(directory: &Path) -> (AppState, String, Arc<MockProvider>) {
    let store = Store::open(&directory.join("history.sqlite")).unwrap();
    let workspace = store
        .create_workspace(directory.to_str().unwrap(), "images")
        .unwrap();
    let session = store.create_session(&workspace.id, "image task").unwrap();
    let provider = Arc::new(MockProvider::text("image received"));
    let mut state = AppState::new(store, "test-only".into(), provider.clone());
    state.observations_dir = directory.join("private-observations");
    (state, session.id, provider)
}

fn message(session: &str, path: &Path) -> Value {
    json!({"sessionId": session, "message": {"role": "user", "content": "查看附件", "attachments": [path]}})
}

async fn completed(events: &mut tokio::sync::broadcast::Receiver<Event>, session: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if matches!(events.recv().await.unwrap(), Event::SessionStatusChanged {session_id, status: SessionStatus::Idle} if session_id == session) {
                break;
            }
        }
    }).await.unwrap();
}

fn files(directory: &Path) -> usize {
    std::fs::read_dir(directory)
        .map(|entries| entries.count())
        .unwrap_or(0)
}

#[test]
fn durable_copy_preserves_name_mime_original_bytes_and_private_permissions() {
    let directory = tempfile::tempdir().unwrap();
    let storage = directory.path().join("private/attachments");
    for (name, mime) in [
        ("中文参考.PNG", "image/png"),
        ("原图.jpeg", "image/jpeg"),
        ("动画.gif", "image/gif"),
        ("样例.webp", "image/webp"),
    ] {
        let source = directory.path().join(name);
        // Ingestion must preserve exact bytes, including animations and metadata;
        // image interpretation belongs to the vision provider, not the copy step.
        let bytes = [name.as_bytes(), b"\0original\xffbytes"].concat();
        std::fs::write(&source, &bytes).unwrap();
        let prepared = prepare(&[source.to_string_lossy().into_owned()], &storage).unwrap();
        let item = prepared.items()[0].clone();
        assert_eq!(item.name, name);
        assert_eq!(item.mime_type.as_deref(), Some(mime));
        assert_ne!(Path::new(&item.path), source);
        assert_eq!(Path::new(&item.path).file_name().unwrap(), name);
        assert!(Path::new(&item.path).starts_with(storage.canonicalize().unwrap()));
        prepared.commit();
        std::fs::write(&source, "changed").unwrap();
        std::fs::remove_file(&source).unwrap();
        assert_eq!(
            miniq_models::read_image_bytes(Path::new(&item.path)).unwrap(),
            bytes
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&item.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                storage.metadata().unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}

#[test]
fn reusing_a_snapshot_preserves_its_name_without_copying_or_owning_existing_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("参考图.jpeg");
    let storage = directory.path().join("attachments");
    std::fs::write(&source, "original image").unwrap();
    let prepared = prepare(&[source.to_string_lossy().into_owned()], &storage).unwrap();
    let item = prepared.items()[0].clone();
    prepared.commit();
    std::fs::remove_file(source).unwrap();
    let reused = prepare(std::slice::from_ref(&item.path), &storage).unwrap();
    assert_eq!(reused.items()[0], item);
    assert_eq!(files(&storage), 1);
    drop(reused);
    let failed = prepare(
        &[
            item.path.clone(),
            directory
                .path()
                .join("absent.png")
                .to_string_lossy()
                .into_owned(),
        ],
        &storage,
    );
    assert!(failed.is_err());
    assert_eq!(std::fs::read(item.path).unwrap(), b"original image");
    assert_eq!(files(&storage), 1);
}

#[test]
fn invalid_later_attachment_rolls_back_snapshots_and_does_not_touch_source_files() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("valid.png");
    let storage = directory.path().join("attachments");
    std::fs::write(&source, "original").unwrap();
    let result = prepare(
        &[
            source.to_string_lossy().into_owned(),
            directory
                .path()
                .join("missing.png")
                .to_string_lossy()
                .into_owned(),
        ],
        &storage,
    );
    assert!(result.is_err());
    assert_eq!(files(&storage), 0);
    assert_eq!(std::fs::read(&source).unwrap(), b"original");
}

#[test]
fn missing_new_attachment_rejects_the_message_without_partial_history_or_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session, provider) = fixture(directory.path());
    let source = directory.path().join("available.png");
    let absent = directory.path().join("missing.png");
    std::fs::write(&source, "available image").unwrap();
    let mut input = message(&session, &source);
    input["message"]["attachments"] = json!([source, absent]);
    let error = super::super::send_message(&state, Some(input)).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidParams as i64);
    assert!(error.message.contains("missing.png"));
    assert!(state.store.list_messages(&session).unwrap().is_empty());
    assert!(state
        .store
        .list_queued_messages(&session)
        .unwrap()
        .is_empty());
    assert_eq!(
        state.store.get_session(&session).unwrap().status,
        SessionStatus::Idle
    );
    assert!(provider.requests.lock().unwrap().is_empty());
    assert_eq!(files(&state.observations_dir.join("attachments")), 0);
    assert_eq!(std::fs::read(source).unwrap(), b"available image");
}

#[test]
fn oversized_images_are_rejected_and_regular_file_paths_remain_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let image = directory.path().join("large.png");
    std::fs::File::create(&image)
        .unwrap()
        .set_len(20 * 1024 * 1024 + 1)
        .unwrap();
    let storage = directory.path().join("attachments");
    assert!(prepare(&[image.to_string_lossy().into_owned()], &storage).is_err());
    assert!(!storage.exists());
    let document = directory.path().join("report.pdf");
    std::fs::write(&document, "document").unwrap();
    let prepared = prepare(&[document.to_string_lossy().into_owned()], &storage).unwrap();
    assert_eq!(
        Path::new(&prepared.items()[0].path),
        document.canonicalize().unwrap()
    );
    assert_eq!(prepared.items()[0].mime_type, None);
    drop(prepared);
    assert!(document.is_file());
}

#[tokio::test]
async fn send_keeps_pixels_available_after_source_removal_and_store_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session, provider) = fixture(directory.path());
    let source = directory.path().join("微信临时图片.png");
    std::fs::write(&source, "original image payload").unwrap();
    let mut events = state.events.subscribe();
    let response = super::super::send_message(&state, Some(message(&session, &source))).unwrap();
    std::fs::remove_file(source).unwrap();
    completed(&mut events, &session).await;
    let path = response["message"]["attachments"][0]["path"]
        .as_str()
        .unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"original image payload");
    assert_eq!(
        provider.requests.lock().unwrap()[0]
            .messages
            .iter()
            .flat_map(|message| &message.images)
            .next()
            .unwrap()
            .path,
        path
    );
    let reopened = Store::open(&directory.path().join("history.sqlite")).unwrap();
    let stored = reopened.list_messages(&session).unwrap();
    assert_eq!(stored[0].attachments[0].path, path);
    assert_eq!(stored[0].attachments[0].name, "微信临时图片.png");
}

#[tokio::test]
async fn rewritten_user_message_uses_a_new_durable_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session, _) = fixture(directory.path());
    let original = state
        .store
        .append_message(&session, Role::User, "old")
        .unwrap();
    let source = directory.path().join("replacement.jpg");
    std::fs::write(&source, "replacement image").unwrap();
    let mut input = message(&session, &source);
    input["messageId"] = json!(original.id);
    let mut events = state.events.subscribe();
    let response = super::super::rewrite_message(&state, Some(input)).unwrap();
    std::fs::remove_file(source).unwrap();
    completed(&mut events, &session).await;
    let attachment = &response["message"]["attachments"][0];
    assert_eq!(
        std::fs::read(attachment["path"].as_str().unwrap()).unwrap(),
        b"replacement image"
    );
    assert_eq!(attachment["name"], "replacement.jpg");
    assert_eq!(attachment["mimeType"], "image/jpeg");
}

#[test]
fn queued_message_is_snapshot_before_acknowledgement_and_keeps_it_when_promoted() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session, _) = fixture(directory.path());
    let source = directory.path().join("queued.webp");
    std::fs::write(&source, "queued image").unwrap();
    assert!(state.begin_turn(&session).is_some());
    let response = super::super::send_message(&state, Some(message(&session, &source))).unwrap();
    let path = response["queued"]["attachments"][0]["path"]
        .as_str()
        .unwrap();
    std::fs::remove_file(source).unwrap();
    let promoted = state.store.start_queued_message(&session).unwrap().unwrap();
    assert_eq!(promoted.attachments[0].path, path);
    assert_eq!(std::fs::read(path).unwrap(), b"queued image");
    state.end_turn(&session);
}

#[test]
fn rejected_send_and_rewrite_remove_only_uncommitted_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session, _) = fixture(directory.path());
    let source = directory.path().join("image.png");
    std::fs::write(&source, "image").unwrap();
    let storage = state.observations_dir.join("attachments");
    assert!(state.begin_turn(&session).is_some());
    let mut input = message(&session, &source);
    input["rejectIfBusy"] = json!(true);
    assert!(super::super::send_message(&state, Some(input)).is_err());
    assert_eq!(files(&storage), 0);
    state.end_turn(&session);
    let assistant = state
        .store
        .append_message(&session, Role::Assistant, "existing answer")
        .unwrap();
    let mut input = message(&session, &source);
    input["messageId"] = json!(assistant.id);
    assert!(super::super::rewrite_message(&state, Some(input)).is_err());
    assert_eq!(files(&storage), 0);
    assert_eq!(std::fs::read(&source).unwrap(), b"image");
    assert_eq!(
        state.store.list_messages(&session).unwrap()[0].content,
        "existing answer"
    );
}
