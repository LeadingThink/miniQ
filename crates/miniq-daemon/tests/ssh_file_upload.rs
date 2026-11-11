//! Exercise connection uploads through the same gateway used by SSH host.call.
use base64::Engine;
use miniq_daemon::{gateway::dispatch, state::AppState};
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::{RpcRequest, RpcResponse};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

fn fixture(project: &Path) -> (AppState, String, String, String) {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(project.to_str().unwrap(), "SSH uploads")
        .unwrap();
    let first = store.create_session(&workspace.id, "first").unwrap();
    let second = store.create_session(&workspace.id, "second").unwrap();
    (
        AppState::new(store, "test".into(), Arc::new(MockProvider::new(vec![]))),
        workspace.id,
        first.id,
        second.id,
    )
}

async fn call(state: &AppState, actor: Option<&str>, method: &str, params: Value) -> RpcResponse {
    dispatch(
        state,
        RpcRequest::new(1_i64, method, Some(params)).with_origin(actor.map(str::to_owned)),
    )
    .await
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn prepare(
    state: &AppState,
    actor: Option<&str>,
    scope: Value,
    name: &str,
    bytes: &[u8],
) -> Value {
    let mut params = scope;
    params["name"] = json!(name);
    params["size"] = json!(bytes.len());
    params["sha256"] = json!(hash(bytes));
    let response = call(state, actor, "file.upload.prepare", params).await;
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}

async fn write(
    state: &AppState,
    actor: Option<&str>,
    scope: Value,
    transfer_id: &Value,
    offset: usize,
    bytes: &[u8],
) -> Value {
    let mut params = scope;
    params["transferId"] = transfer_id.clone();
    params["offset"] = json!(offset);
    params["dataBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    let response = call(state, actor, "file.upload.write", params).await;
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}

#[tokio::test]
async fn gateway_uploads_session_and_workspace_scopes_atomically() {
    let project = tempfile::tempdir().unwrap();
    let (state, workspace, session, _) = fixture(project.path());
    let actor = Some("remote:ssh-phone");
    let bytes: Vec<u8> = (0..262_144 + 19).map(|index| (index % 251) as u8).collect();
    for (scope, expected_root) in [
        (json!({"sessionId":session}), project.path().to_path_buf()),
        (
            json!({"workspaceId":workspace}),
            project.path().to_path_buf(),
        ),
    ] {
        let ticket = prepare(&state, actor, scope.clone(), "incoming.bin", &bytes).await;
        assert_eq!(ticket["transport"], "connection");
        assert_eq!(ticket["chunkBytes"], 262_144);
        let first = write(
            &state,
            actor,
            scope.clone(),
            &ticket["transferId"],
            0,
            &bytes[..262_144],
        )
        .await;
        assert_eq!(first["nextOffset"], 262_144);
        let second = write(
            &state,
            actor,
            scope.clone(),
            &ticket["transferId"],
            262_144,
            &bytes[262_144..],
        )
        .await;
        assert_eq!(second["nextOffset"], bytes.len());
        let committed = call(
            &state,
            actor,
            "file.upload.commit",
            json!({"transferId":ticket["transferId"],
                "sessionId":scope["sessionId"],"workspaceId":scope["workspaceId"]}),
        )
        .await;
        assert!(committed.error.is_none(), "{:?}", committed.error);
        let result = committed.result.unwrap();
        assert_eq!(result["status"], "completed");
        assert_eq!(result["size"], bytes.len());
        assert_eq!(result["sha256"], hash(&bytes));
        let path = Path::new(result["path"].as_str().unwrap());
        assert!(path.starts_with(dunce::canonicalize(&expected_root).unwrap().join("inbox")));
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        let receipt = call(
            &state,
            actor,
            "file.transfer.cancel",
            json!({"transferId":ticket["transferId"],
                "sessionId":scope["sessionId"],"workspaceId":scope["workspaceId"]}),
        )
        .await;
        assert_eq!(receipt.result.unwrap()["status"], "completed");
    }
}

#[tokio::test]
async fn upload_write_enforces_actor_scope_order_and_hash() {
    let project = tempfile::tempdir().unwrap();
    let (state, _workspace, session, other) = fixture(project.path());
    let actor = Some("remote:ssh-phone");
    let bytes = b"ordered upload";
    let ticket = prepare(
        &state,
        actor,
        json!({"sessionId":session}),
        "ordered.txt",
        bytes,
    )
    .await;
    for (wrong_actor, wrong_scope) in [
        (None, json!({"sessionId":session})),
        (Some("remote:other"), json!({"sessionId":session})),
        (actor, json!({"sessionId":other})),
    ] {
        let mut params = wrong_scope;
        params["transferId"] = ticket["transferId"].clone();
        params["offset"] = json!(0);
        params["dataBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        assert!(call(&state, wrong_actor, "file.upload.write", params)
            .await
            .error
            .is_some());
    }
    let mut skipped = json!({"sessionId":session});
    skipped["transferId"] = ticket["transferId"].clone();
    skipped["offset"] = json!(1);
    skipped["dataBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    assert!(call(&state, actor, "file.upload.write", skipped)
        .await
        .error
        .is_some());
    write(
        &state,
        actor,
        json!({"sessionId":session}),
        &ticket["transferId"],
        0,
        bytes,
    )
    .await;
    assert!(call(
        &state,
        actor,
        "file.upload.commit",
        json!({"sessionId":session,"transferId":ticket["transferId"]})
    )
    .await
    .error
    .is_none());

    let wrong = call(
        &state,
        actor,
        "file.upload.prepare",
        json!({"sessionId":session,"name":"wrong-hash.txt",
            "size":bytes.len(),"sha256":"0".repeat(64)}),
    )
    .await
    .result
    .unwrap();
    write(
        &state,
        actor,
        json!({"sessionId":session}),
        &wrong["transferId"],
        0,
        bytes,
    )
    .await;
    assert!(call(
        &state,
        actor,
        "file.upload.commit",
        json!({"sessionId":session,"transferId":wrong["transferId"]})
    )
    .await
    .error
    .is_some());
}

#[tokio::test]
async fn upload_cancel_status_limits_and_expiry_are_isolated_from_downloads() {
    let project = tempfile::tempdir().unwrap();
    let (state, _workspace, session, _) = fixture(project.path());
    let actor = Some("remote:ssh-phone");
    let data = b"cancel me";
    let upload = prepare(
        &state,
        actor,
        json!({"sessionId":session}),
        "cancel.txt",
        data,
    )
    .await;
    let mut cancel = json!({"sessionId":session,"transferId":upload["transferId"]});
    assert_eq!(
        call(&state, actor, "file.transfer.cancel", cancel.clone())
            .await
            .result
            .unwrap()["status"],
        "cancelled"
    );
    assert!(call(&state, actor, "file.upload.commit", cancel.clone())
        .await
        .error
        .is_some());

    let mut handles = Vec::new();
    for index in 0..2 {
        handles.push(
            prepare(
                &state,
                actor,
                json!({"sessionId":session}),
                &format!("limited-{index}.bin"),
                b"x",
            )
            .await,
        );
    }
    assert!(call(
        &state,
        actor,
        "file.upload.prepare",
        json!({"sessionId":session,"name":"third.bin","size":1,"sha256":hash(b"x")})
    )
    .await
    .error
    .is_some());
    for handle in handles {
        cancel["transferId"] = handle["transferId"].clone();
        call(&state, actor, "file.transfer.cancel", cancel.clone()).await;
    }

    tokio::time::pause();
    let expired = prepare(
        &state,
        actor,
        json!({"sessionId":session}),
        "expired.txt",
        b"x",
    )
    .await;
    tokio::time::advance(std::time::Duration::from_secs(899)).await;
    let scope = json!({"sessionId":session,"transferId":expired["transferId"]});
    assert_eq!(
        call(&state, actor, "file.transfer.status", scope.clone())
            .await
            .result
            .unwrap()["status"],
        "ready"
    );
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    assert!(call(
        &state,
        actor,
        "file.transfer.status",
        json!({"sessionId":session,"transferId":expired["transferId"]})
    )
    .await
    .error
    .is_some());
    for method in ["file.upload.commit", "file.transfer.cancel"] {
        assert!(call(&state, actor, method, scope.clone())
            .await
            .error
            .is_some());
    }
    for index in 0..2 {
        let next = prepare(
            &state,
            actor,
            json!({"sessionId":session}),
            &format!("after-expiry-{index}.txt"),
            b"x",
        )
        .await;
        assert_ne!(next["transferId"], expired["transferId"]);
    }
}

#[tokio::test]
async fn completed_uploads_release_slots_for_later_files() {
    let project = tempfile::tempdir().unwrap();
    let (state, _workspace, session, _) = fixture(project.path());
    let actor = Some("remote:ssh-phone");
    for index in 0..7 {
        let bytes = format!("sequential-{index}");
        let scope = json!({"sessionId":session});
        let ticket = prepare(
            &state,
            actor,
            scope.clone(),
            &format!("sequential-{index}.txt"),
            bytes.as_bytes(),
        )
        .await;
        write(
            &state,
            actor,
            scope,
            &ticket["transferId"],
            0,
            bytes.as_bytes(),
        )
        .await;
        let committed = call(
            &state,
            actor,
            "file.upload.commit",
            json!({"sessionId":session,"transferId":ticket["transferId"]}),
        )
        .await;
        assert!(
            committed.error.is_none(),
            "sequential upload {index}: {:?}",
            committed.error
        );
        assert_eq!(committed.result.unwrap()["status"], "completed");
    }
}
