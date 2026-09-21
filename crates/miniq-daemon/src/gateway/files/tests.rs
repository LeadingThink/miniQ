use super::*;

fn fixture() -> (tempfile::TempDir, Scope) {
    let directory = tempfile::tempdir().unwrap();
    let scope = Scope {
        cwd: directory.path().to_string_lossy().into_owned(),
        roots: vec![],
    };
    (directory, scope)
}

#[test]
fn chunked_files_preserve_bytes_and_detect_updates() {
    let (directory, _) = fixture();
    let path = directory.path().join("中文报告.pdf");
    let bytes: Vec<u8> = (0..CHUNK_BYTES as usize + 101)
        .map(|i| (i % 251) as u8)
        .collect();
    std::fs::write(&path, &bytes).unwrap();
    let mut input = ReadInput {
        session_id: "fixture".into(),
        path: path.to_string_lossy().into_owned(),
        revision: revision(&path.metadata().unwrap()).unwrap(),
        offset: 0,
    };
    let mut restored = Vec::new();
    loop {
        let chunk = read_chunk(&path, &input).unwrap();
        restored.extend(
            base64::engine::general_purpose::STANDARD
                .decode(chunk["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
        input.offset = chunk["nextOffset"].as_u64().unwrap();
        if chunk["done"] == true {
            break;
        }
    }
    assert_eq!(restored, bytes);
    input.offset += 1;
    assert!(read_chunk(&path, &input).is_err());
    input.offset = 0;
    std::fs::write(&path, "new file").unwrap();
    assert!(read_chunk(&path, &input).unwrap_err().contains("已更新"));
}

#[test]
fn directory_pagination_and_attached_roots_do_not_lose_entries() {
    let (directory, scope) = fixture();
    for i in 0..205 {
        std::fs::write(directory.path().join(format!("报告{i:03}.md")), "# report").unwrap();
    }
    let mut input = ListInput {
        session_id: "fixture".into(),
        path: "".into(),
        after: None,
    };
    let mut names = Vec::new();
    loop {
        let page = list_directory(&scope, &input).unwrap();
        assert!(page["entries"].as_array().unwrap().len() <= PAGE_SIZE);
        names.extend(
            page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["name"].as_str().unwrap().to_owned()),
        );
        input.after = page["nextCursor"].as_str().map(str::to_owned);
        if input.after.is_none() {
            break;
        }
    }
    assert_eq!(names.len(), 205);
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 205);
    let extra = tempfile::tempdir().unwrap();
    input.path = extra.path().to_string_lossy().into_owned();
    assert!(list_directory(&scope, &input).is_err());
    let scope = Scope {
        roots: vec![input.path.clone()],
        ..scope
    };
    assert!(list_directory(&scope, &input).is_ok());
}

#[tokio::test]
async fn rpc_uses_persisted_session_roots_and_rejects_injected_authority() {
    let (directory, _) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("private.txt");
    std::fs::write(&secret, "private").unwrap();
    std::fs::write(directory.path().join("result.md"), "# 结果").unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "test")
        .unwrap();
    let session = store.create_session(&workspace.id, "test").unwrap();
    let state = AppState::new(
        store,
        "test".into(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(vec![])),
    );
    let input = json!({"sessionId":session.id,"path":"result.md"});
    let result = describe(&state, Some(input.clone())).await.unwrap();
    assert_eq!(result["kind"], "markdown");
    let mut forged = input.clone();
    forged["workspacePaths"] = json!([outside.path()]);
    assert!(describe(&state, Some(forged)).await.is_err());
    let mut outside_file = input.clone();
    outside_file["path"] = json!(secret);
    assert!(describe(&state, Some(outside_file)).await.is_err());
    let mut absent = input;
    absent["sessionId"] = json!("missing");
    assert!(describe(&state, Some(absent)).await.is_err());
    #[cfg(unix)]
    {
        let link = directory.path().join("escape.txt");
        std::os::unix::fs::symlink(secret, &link).unwrap();
        assert!(
            describe(&state, Some(json!({"sessionId":session.id,"path":link})))
                .await
                .is_err()
        );
        let page = list(&state, Some(json!({"sessionId":session.id})))
            .await
            .unwrap();
        assert_eq!(page["entries"].as_array().unwrap().len(), 1);
        std::os::unix::fs::symlink("missing.txt", directory.path().join("broken.txt")).unwrap();
        let page = list(&state, Some(json!({"sessionId":session.id})))
            .await
            .unwrap();
        let entries = page["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["name"], "broken.txt");
        assert_eq!(entries[0]["unavailable"], true);
    }
}

fn attachment_state(project: &Path) -> (AppState, String, String) {
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(project.to_str().unwrap(), "same project")
        .unwrap();
    let owner = store.create_session(&workspace.id, "owner").unwrap();
    let other = store.create_session(&workspace.id, "other").unwrap();
    let state = AppState::new(
        store,
        "test".into(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(vec![])),
    );
    (state, owner.id, other.id)
}

fn saved_attachment(path: &Path) -> miniq_protocol::MessageAttachment {
    miniq_protocol::MessageAttachment {
        path: path.to_str().unwrap().into(),
        name: path.file_name().unwrap().to_str().unwrap().into(),
        mime_type: Some("image/png".into()),
    }
}

async fn preview_attachment(
    state: &AppState,
    session: &str,
    path: &Path,
    expected: &[u8],
) -> Value {
    let info = describe(state, Some(json!({"sessionId":session,"path":path})))
        .await
        .unwrap();
    assert_eq!(info["kind"], "image");
    assert_eq!(info["mimeType"], "image/png");
    let input = json!({"sessionId":session,"path":path,"revision":info["revision"],"offset":0});
    let bytes = read(state, Some(input.clone())).await.unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(bytes["dataBase64"].as_str().unwrap())
            .unwrap(),
        expected
    );
    assert_eq!(bytes["done"], true);
    input
}

#[tokio::test]
async fn persisted_attachment_preview_is_exact_session_scoped_and_does_not_grant_directory_access()
{
    let project = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let storage = data
        .path()
        .canonicalize()
        .unwrap()
        .join("observations/attachments");
    std::fs::create_dir_all(&storage).unwrap();
    let path = storage.join("persistent-copy.png");
    let neighbor = storage.join("other-private-file.png");
    let bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=").unwrap();
    std::fs::write(&path, &bytes).unwrap();
    std::fs::write(&neighbor, "private neighbor").unwrap();
    let (mut state, owner, other) = attachment_state(project.path());
    state.observations_dir = storage.parent().unwrap().into();
    state
        .store
        .append_message_with_attachments(
            &owner,
            miniq_protocol::Role::User,
            "analyze image",
            &[saved_attachment(&path)],
        )
        .unwrap();
    let input = preview_attachment(&state, &owner, &path, &bytes).await;

    assert!(
        describe(&state, Some(json!({"sessionId":other,"path":path})))
            .await
            .is_err()
    );
    let mut cross_session = input.clone();
    cross_session["sessionId"] = json!(other);
    assert!(read(&state, Some(cross_session)).await.is_err());
    assert!(
        describe(&state, Some(json!({"sessionId":owner,"path":neighbor})))
            .await
            .is_err()
    );
    let mut adjacent = input;
    adjacent["path"] = json!(neighbor);
    assert!(read(&state, Some(adjacent)).await.is_err());
    assert!(
        list(&state, Some(json!({"sessionId":owner,"path":storage})))
            .await
            .is_err()
    );
    assert!(
        describe(&state, Some(json!({"sessionId":owner,"path":storage})))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn queued_attachment_preview_survives_promotion_and_loses_access_after_removal() {
    let project = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let path = data.path().canonicalize().unwrap().join("queued.png");
    std::fs::write(&path, "queued image bytes").unwrap();
    let (state, owner, other) = attachment_state(project.path());
    let queued = state
        .store
        .enqueue_message_with_attachments(&owner, "later", &[saved_attachment(&path)])
        .unwrap();
    let input = preview_attachment(&state, &owner, &path, b"queued image bytes").await;
    assert!(
        describe(&state, Some(json!({"sessionId":other,"path":path})))
            .await
            .is_err()
    );
    state.store.remove_queued_message(&queued.id).unwrap();
    assert!(read(&state, Some(input)).await.is_err());
    state
        .store
        .enqueue_message_with_attachments(&owner, "later", &[saved_attachment(&path)])
        .unwrap();
    state.store.start_queued_message(&owner).unwrap().unwrap();
    preview_attachment(&state, &owner, &path, b"queued image bytes").await;
}

#[cfg(unix)]
#[tokio::test]
async fn replacing_a_persisted_attachment_with_a_symlink_cannot_authorize_its_target() {
    let project = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let private = tempfile::tempdir().unwrap();
    let path = data.path().canonicalize().unwrap().join("attached.png");
    let secret = private.path().join("private.png");
    std::fs::write(&path, "attachment bytes").unwrap();
    std::fs::write(&secret, "not attached bytes").unwrap();
    let (state, owner, _) = attachment_state(project.path());
    state
        .store
        .append_message_with_attachments(
            &owner,
            miniq_protocol::Role::User,
            "inspect",
            &[saved_attachment(&path)],
        )
        .unwrap();
    let input = preview_attachment(&state, &owner, &path, b"attachment bytes").await;
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&secret, &path).unwrap();
    assert!(
        describe(&state, Some(json!({"sessionId":owner,"path":path})))
            .await
            .is_err()
    );
    assert!(read(&state, Some(input)).await.is_err());
    assert!(
        describe(&state, Some(json!({"sessionId":owner,"path":secret})))
            .await
            .is_err()
    );
}
