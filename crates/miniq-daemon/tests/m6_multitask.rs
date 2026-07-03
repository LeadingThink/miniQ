//! M6 acceptance (multi-tasking): turns in different workspaces run in
//! parallel; a second session in the SAME workspace is rejected while a
//! turn is active.

use futures_util::{SinkExt, StreamExt};
use miniq_daemon::server;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use miniq_models::{ChatDelta, DeltaStream, ModelProvider, ProviderError};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type WsClient = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Provider whose turns block until released, so tests can hold a turn open.
struct GatedProvider {
    release: tokio::sync::watch::Receiver<bool>,
}

#[async_trait::async_trait]
impl ModelProvider for GatedProvider {
    async fn stream_complete(
        &self,
        _request: miniq_models::CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let mut release = self.release.clone();
        // Wait until the test flips the gate.
        while !*release.borrow() {
            if release.changed().await.is_err() {
                break;
            }
        }
        Ok(Box::pin(futures_util::stream::iter(vec![
            Ok(ChatDelta::Text("done".into())),
            Ok(ChatDelta::Finished),
        ])))
    }
    fn describe(&self) -> String {
        "gated".into()
    }
}

async fn start(provider: Arc<dyn ModelProvider>) -> (u16, String) {
    let token = "test-token".to_string();
    let store = Store::open_in_memory().unwrap();
    let state = AppState::new(store, token.clone(), provider);
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { server::serve(listener, state).await.unwrap() });
    (port, token)
}

async fn connect(port: u16, token: &str) -> WsClient {
    let (ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws?token={token}"))
        .await
        .expect("connect");
    ws
}

async fn call(ws: &mut WsClient, id: &str, method: &str, params: Value) -> Value {
    let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    ws.send(Message::Text(req.to_string().into())).await.unwrap();
    loop {
        let msg = ws.next().await.expect("stream open").expect("ws ok");
        let Message::Text(text) = msg else { continue };
        let v: Value = serde_json::from_str(&text).unwrap();
        if v.get("id").and_then(|i| i.as_str()) == Some(id) {
            return v;
        }
    }
}

#[tokio::test]
async fn same_workspace_serialized_cross_workspace_parallel() {
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let provider: Arc<dyn ModelProvider> = Arc::new(GatedProvider { release: release_rx });
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let ws_a = call(&mut ws, "r1", "workspace.open", json!({"path": dir_a.path().to_string_lossy()}))
        .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ws_b = call(&mut ws, "r2", "workspace.open", json!({"path": dir_b.path().to_string_lossy()}))
        .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let sess_a1 = call(&mut ws, "r3", "session.create", json!({"workspaceId": ws_a}))
        .await["result"]["id"].as_str().unwrap().to_string();
    let sess_a2 = call(&mut ws, "r4", "session.create", json!({"workspaceId": ws_a}))
        .await["result"]["id"].as_str().unwrap().to_string();
    let sess_b = call(&mut ws, "r5", "session.create", json!({"workspaceId": ws_b}))
        .await["result"]["id"].as_str().unwrap().to_string();

    // Start a (gated) turn in workspace A.
    let send = |sess: &str| json!({"sessionId": sess, "message": {"role": "user", "content": "go"}});
    let resp = call(&mut ws, "r6", "session.sendMessage", send(&sess_a1)).await;
    assert!(resp.get("result").is_some(), "first turn starts: {resp}");

    // Second session in the SAME workspace is rejected as busy.
    let resp = call(&mut ws, "r7", "session.sendMessage", send(&sess_a2)).await;
    assert_eq!(resp["error"]["code"], -32003, "same workspace must be busy: {resp}");

    // A session in ANOTHER workspace runs in parallel.
    let resp = call(&mut ws, "r8", "session.sendMessage", send(&sess_b)).await;
    assert!(resp.get("result").is_some(), "other workspace runs in parallel: {resp}");

    // Release the gate; both turns complete.
    release_tx.send(true).unwrap();
    let mut completed = std::collections::HashSet::new();
    while completed.len() < 2 {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("turns complete")
            .unwrap()
            .unwrap();
        let Message::Text(text) = msg else { continue };
        let v: Value = serde_json::from_str(&text).unwrap();
        if v["type"] == "turn_completed" {
            completed.insert(v["sessionId"].as_str().unwrap().to_string());
        }
    }
    assert!(completed.contains(&sess_a1));
    assert!(completed.contains(&sess_b));

    // Workspace A is free again.
    let resp = call(&mut ws, "r9", "session.sendMessage", send(&sess_a2)).await;
    assert!(resp.get("result").is_some(), "workspace A freed after turn: {resp}");
    release_tx.send(true).ok();
}
