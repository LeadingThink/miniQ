//! Exercise the actual gateway used by `miniq bridge`, including forwarded mobile origins.
use base64::Engine;
use miniq_daemon::{gateway::dispatch, state::AppState};
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::{RpcRequest, RpcResponse};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

fn fixture(project: &Path) -> (AppState, String, String) {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(project.to_str().unwrap(), "SSH files")
        .unwrap();
    let first = store.create_session(&workspace.id, "first").unwrap();
    let second = store.create_session(&workspace.id, "second").unwrap();
    (
        AppState::new(store, "test".into(), Arc::new(MockProvider::new(vec![]))),
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
async fn prepare(state: &AppState, actor: Option<&str>, session: &str, path: &Path) -> Value {
    let description = call(
        state,
        actor,
        "file.describe",
        json!({"sessionId":session,"path":path}),
    )
    .await
    .result
    .unwrap();
    let reply = call(
        state,
        actor,
        "file.download.prepare",
        json!({"sessionId":session,"path":path,"revision":description["revision"]}),
    )
    .await;
    assert!(reply.error.is_none(), "{:?}", reply.error);
    reply.result.unwrap()
}

#[tokio::test]
async fn bridge_downloads_binary_and_empty_files_without_relay_storage() {
    let project = tempfile::tempdir().unwrap();
    let (state, session, _) = fixture(project.path());
    for actor in [None, Some("remote:phone")] {
        for bytes in [
            vec![],
            (0..700_001).map(|n| (n % 251) as u8).collect::<Vec<_>>(),
        ] {
            let path = project.path().join("报告.pdf");
            std::fs::write(&path, &bytes).unwrap();
            let ticket = prepare(&state, actor, &session, &path).await;
            assert_eq!(ticket["transport"], "connection");
            assert_eq!(ticket["sha256"], format!("{:x}", Sha256::digest(&bytes)));
            let mut received = Vec::new();
            loop {
                let reply = call(
                    &state,
                    actor,
                    "file.download.read",
                    json!({"sessionId":session,
                    "transferId":ticket["transferId"],"offset":received.len(),"length":262144}),
                )
                .await;
                assert!(reply.error.is_none(), "{:?}", reply.error);
                let block = reply.result.unwrap();
                assert_eq!(block["offset"], received.len());
                assert_eq!(block["revision"], ticket["revision"]);
                received.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(block["dataBase64"].as_str().unwrap())
                        .unwrap(),
                );
                assert_eq!(block["nextOffset"], received.len());
                if block["done"] == true {
                    break;
                }
            }
            assert_eq!(received, bytes);
            let scope = json!({"sessionId":session,"transferId":ticket["transferId"]});
            assert_eq!(
                call(&state, actor, "file.transfer.status", scope.clone())
                    .await
                    .result
                    .unwrap()["status"],
                "ready"
            );
            assert_eq!(
                call(&state, actor, "file.transfer.cancel", scope.clone())
                    .await
                    .result
                    .unwrap()["status"],
                "cancelled"
            );
            assert!(call(&state, actor, "file.transfer.status", scope)
                .await
                .error
                .is_some());
        }
    }
}

#[tokio::test]
async fn download_handles_enforce_actor_session_bounds_and_cancellation() {
    let project = tempfile::tempdir().unwrap();
    let (state, session, other) = fixture(project.path());
    let path = project.path().join("script.sh");
    std::fs::write(&path, b"#!/bin/sh\necho ok\n").unwrap();
    let actor = Some("remote:phone");
    let ticket = prepare(&state, actor, &session, &path).await;
    let read = json!({"sessionId":session,"transferId":ticket["transferId"],"offset":0,"length":4});
    for wrong in [None, Some("remote:other")] {
        assert!(call(&state, wrong, "file.download.read", read.clone())
            .await
            .error
            .is_some());
        assert!(call(
            &state,
            wrong,
            "file.transfer.cancel",
            json!({"sessionId":session,"transferId":ticket["transferId"]})
        )
        .await
        .error
        .is_some());
    }
    for (field, value) in [
        ("sessionId", json!(other)),
        ("offset", json!(-1)),
        ("offset", json!(999)),
        ("length", json!(0)),
        ("length", json!(262145)),
        ("path", json!(path)),
    ] {
        let mut invalid = read.clone();
        invalid[field] = value;
        assert!(
            call(&state, actor, "file.download.read", invalid)
                .await
                .error
                .is_some(),
            "{field}"
        );
    }
    assert!(call(&state, actor, "file.download.read", read.clone())
        .await
        .error
        .is_none());
    call(
        &state,
        actor,
        "file.transfer.cancel",
        json!({"sessionId":session,"transferId":ticket["transferId"]}),
    )
    .await;
    assert!(call(&state, actor, "file.download.read", read)
        .await
        .error
        .is_some());
}

#[tokio::test]
async fn preparation_and_reads_reject_unauthorized_or_changed_files() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (state, session, _) = fixture(project.path());
    let path = project.path().join("report.md");
    let secret = outside.path().join("secret.md");
    std::fs::write(&path, b"old").unwrap();
    std::fs::write(&secret, b"secret").unwrap();
    let actor = Some("remote:phone");
    for file in [&secret, project.path()] {
        assert!(call(
            &state,
            actor,
            "file.download.prepare",
            json!({"sessionId":session,"path":file,"revision":"x"})
        )
        .await
        .error
        .is_some());
    }
    let ticket = prepare(&state, actor, &session, &path).await;
    std::fs::write(&path, b"changed content").unwrap();
    assert!(call(
        &state,
        actor,
        "file.download.prepare",
        json!({"sessionId":session,"path":path,"revision":ticket["revision"]})
    )
    .await
    .error
    .is_some());
    let read = call(
        &state,
        actor,
        "file.download.read",
        json!({"sessionId":session,"transferId":ticket["transferId"],"offset":0,"length":3}),
    )
    .await;
    assert!(read.error.unwrap().message.contains("changed"));
}

#[tokio::test]
async fn download_lease_expiry_releases_the_handle() {
    let project = tempfile::tempdir().unwrap();
    let (state, session, _) = fixture(project.path());
    let path = project.path().join("empty.txt");
    std::fs::write(&path, []).unwrap();
    let ticket = prepare(&state, None, &session, &path).await;
    tokio::task::yield_now().await;
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(901)).await;
    tokio::task::yield_now().await;
    let result = call(
        &state,
        None,
        "file.transfer.status",
        json!({"sessionId":session,"transferId":ticket["transferId"]}),
    )
    .await;
    assert!(result.error.is_some());
}

#[tokio::test]
async fn download_rejects_oversize_before_hashing_or_reading() {
    let project = tempfile::tempdir().unwrap();
    let (state, session, _) = fixture(project.path());
    let path = project.path().join("large.bin");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(200 * 1024 * 1024 + 1)
        .unwrap();
    let info = call(
        &state,
        None,
        "file.describe",
        json!({"sessionId":session,"path":path}),
    )
    .await
    .result
    .unwrap();
    let result = call(
        &state,
        None,
        "file.download.prepare",
        json!({"sessionId":session,"path":path,"revision":info["revision"]}),
    )
    .await;
    assert!(result.error.unwrap().message.contains("maximum 200 MiB"));
}
