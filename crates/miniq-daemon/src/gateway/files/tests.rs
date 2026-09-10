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
    let (directory, scope) = fixture();
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
        let chunk = read_chunk(&scope, &input).unwrap();
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
    assert!(read_chunk(&scope, &input).is_err());
    input.offset = 0;
    std::fs::write(&path, "new file").unwrap();
    assert!(read_chunk(&scope, &input).unwrap_err().contains("已更新"));
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
