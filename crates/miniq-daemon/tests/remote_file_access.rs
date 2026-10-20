//! All files and permissions in these tests are synthetic and temporary.
use base64::Engine;
use miniq_daemon::{
    gateway::{dispatch, dispatch_authenticated_remote},
    state::AppState,
};
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::{RpcRequest, RpcResponse};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

fn state(project: &Path) -> (AppState, String, String) {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(project.to_str().unwrap(), "test")
        .unwrap();
    let first = store.create_session(&workspace.id, "first").unwrap();
    let second = store.create_session(&workspace.id, "second").unwrap();
    (
        AppState::new(store, "test".into(), Arc::new(MockProvider::new(vec![]))),
        first.id,
        second.id,
    )
}

async fn call(state: &AppState, method: &str, params: Value, origin: Option<&str>) -> RpcResponse {
    let request: RpcRequest = serde_json::from_value(json!({
        "jsonrpc":"2.0", "id":1, "method":method, "params":params,
    }))
    .unwrap();
    dispatch(state, request.with_origin(origin.map(str::to_owned))).await
}

async fn remote(state: &AppState, method: &str, params: Value) -> RpcResponse {
    let request =
        RpcRequest::new(1_i64, method, Some(params)).with_origin(Some("remote:test-phone".into()));
    dispatch_authenticated_remote(state, request).await
}

#[tokio::test]
async fn remote_file_confirmation_grants_only_the_exact_file_and_session() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let file = outside.path().join("report.txt");
    let neighbor = outside.path().join("neighbor.txt");
    std::fs::write(&file, "synthetic report").unwrap();
    std::fs::write(&neighbor, "synthetic neighbor").unwrap();
    let (state, session, other) = state(project.path());
    let params = json!({"sessionId":session,"path":file});
    assert!(remote(&state, "file.describe", params.clone())
        .await
        .error
        .is_some());
    let pending = remote(&state, "file.access.request", params.clone()).await;
    assert!(pending.error.is_none(), "{:?}", pending.error);
    let pending = pending.result.unwrap();
    assert_eq!(pending["path"], json!(dunce::canonicalize(&file).unwrap()));
    assert!(remote(&state, "file.describe", params.clone())
        .await
        .error
        .is_some());
    let decision = json!({"sessionId":session,"requestId":pending["requestId"],"allow":true});
    let accepted = remote(&state, "file.access.resolve", decision.clone()).await;
    assert!(accepted.error.is_none(), "{:?}", accepted.error);
    assert_eq!(accepted.result.unwrap()["allowed"], true);
    let info = remote(&state, "file.describe", params.clone())
        .await
        .result
        .unwrap();
    let read = json!({"sessionId":session,"path":file,"revision":info["revision"],"offset":0});
    let bytes = remote(&state, "file.read", read).await.result.unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(bytes["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"synthetic report"
    );
    for denied in [
        json!({"sessionId":other,"path":file}),
        json!({"sessionId":session,"path":neighbor}),
        json!({"sessionId":session,"path":outside.path()}),
    ] {
        assert!(remote(&state, "file.describe", denied)
            .await
            .error
            .is_some());
    }
    assert!(remote(
        &state,
        "file.list",
        json!({"sessionId":session,"path":outside.path()})
    )
    .await
    .error
    .is_some());
    assert!(remote(&state, "file.access.resolve", decision)
        .await
        .error
        .is_some());
    // A mobile preview permission is not an agent/tool or local RPC permission.
    assert!(call(&state, "file.describe", params, None)
        .await
        .error
        .is_some());
    assert!(!state.is_allowed_for_session(&session, "file_read"));
}

#[tokio::test]
async fn remote_file_rejection_and_wrong_actor_or_session_never_grant_access() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let file = outside.path().join("report.txt");
    std::fs::write(&file, "synthetic").unwrap();
    let (state, session, other) = state(project.path());
    let params = json!({"sessionId":session,"path":file});
    for origin in [
        None,
        Some("local"),
        Some("remote"),
        Some("remote:test-phone"),
    ] {
        assert!(call(&state, "file.access.request", params.clone(), origin)
            .await
            .error
            .is_some());
    }
    let pending = remote(&state, "file.access.request", params.clone())
        .await
        .result
        .unwrap();
    let decision = json!({"sessionId":session,"requestId":pending["requestId"],"allow":true});
    assert!(call(
        &state,
        "file.access.resolve",
        decision.clone(),
        Some("remote:other-phone")
    )
    .await
    .error
    .is_some());
    let other_phone = RpcRequest::new(1_i64, "file.access.resolve", Some(decision.clone()))
        .with_origin(Some("remote:other-phone".into()));
    assert!(dispatch_authenticated_remote(&state, other_phone)
        .await
        .error
        .is_some());
    let mut wrong = decision.clone();
    wrong["sessionId"] = json!(other);
    assert!(remote(&state, "file.access.resolve", wrong)
        .await
        .error
        .is_some());
    let mut rejected = decision.clone();
    rejected["allow"] = json!(false);
    assert_eq!(
        remote(&state, "file.access.resolve", rejected)
            .await
            .result
            .unwrap()["allowed"],
        false
    );
    assert!(remote(&state, "file.access.resolve", decision)
        .await
        .error
        .is_some());
    assert!(remote(&state, "file.describe", params)
        .await
        .error
        .is_some());
}

#[tokio::test]
async fn remote_file_access_refuses_credentials_databases_traversal_and_injected_roots() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (state, session, _) = state(project.path());
    for name in [
        ".ssh/id_ed25519",
        ".aws/credentials",
        ".config/gcloud/config.json",
        "key.pem",
        "secret.key",
        "backup.sqlite3",
        "state.db-wal",
        ".env.production",
        ".miniq/settings.json",
    ] {
        let path = outside.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "synthetic protected data").unwrap();
        let response = remote(
            &state,
            "file.access.request",
            json!({"sessionId":session,"path":path}),
        )
        .await;
        assert!(response.error.is_some(), "must reject {name}");
    }
    let file = outside.path().join("report.txt");
    std::fs::write(&file, "synthetic").unwrap();
    let traversal = project
        .path()
        .join("..")
        .join(outside.path().file_name().unwrap())
        .join("report.txt");
    assert!(remote(
        &state,
        "file.access.request",
        json!({"sessionId":session,"path":traversal})
    )
    .await
    .error
    .is_some());
    for extra in [
        json!({"workspacePaths":[outside.path()]}),
        json!({"authorizedFiles":[file]}),
        json!({"allow":true}),
    ] {
        let mut params = json!({"sessionId":session,"path":file});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(remote(&state, "file.access.request", params)
            .await
            .error
            .is_some());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn remote_file_confirmation_cannot_follow_a_retargeted_symlink_or_replacement() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let one = outside.path().join("one.txt");
    let two = outside.path().join("two.txt");
    let link = outside.path().join("link.txt");
    std::fs::write(&one, "first").unwrap();
    std::fs::write(&two, "second").unwrap();
    std::os::unix::fs::symlink(&one, &link).unwrap();
    let (state, session, _) = state(project.path());
    let pending = remote(
        &state,
        "file.access.request",
        json!({"sessionId":session,"path":link}),
    )
    .await
    .result
    .unwrap();
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&two, &link).unwrap();
    assert!(remote(
        &state,
        "file.access.resolve",
        json!({"sessionId":session,"requestId":pending["requestId"],"allow":true})
    )
    .await
    .error
    .is_some());
    let pending = remote(
        &state,
        "file.access.request",
        json!({"sessionId":session,"path":one}),
    )
    .await
    .result
    .unwrap();
    assert!(remote(
        &state,
        "file.access.resolve",
        json!({"sessionId":session,"requestId":pending["requestId"],"allow":true})
    )
    .await
    .error
    .is_none());
    std::fs::remove_file(&one).unwrap();
    std::os::unix::fs::symlink(&two, &one).unwrap();
    for path in [&one, &two] {
        assert!(remote(
            &state,
            "file.describe",
            json!({"sessionId":session,"path":path})
        )
        .await
        .error
        .is_some());
    }
    std::fs::remove_file(&one).unwrap();
    std::fs::rename(&two, &one).unwrap();
    assert!(remote(
        &state,
        "file.describe",
        json!({"sessionId":session,"path":one})
    )
    .await
    .error
    .is_some());
}
