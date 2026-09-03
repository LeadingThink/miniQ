//! M6 acceptance (multi-tasking): different sessions run in parallel even
//! when they share a workspace. Messages sent to a session with an active
//! turn are queued and drained when the turn ends.

use futures_util::{SinkExt, StreamExt};
use miniq_daemon::server;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use miniq_models::{ChatDelta, DeltaStream, ModelProvider, ProviderError};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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
    ws.send(Message::Text(req.to_string().into()))
        .await
        .unwrap();
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
async fn different_sessions_run_in_parallel_regardless_of_workspace() {
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let provider: Arc<dyn ModelProvider> = Arc::new(GatedProvider {
        release: release_rx,
    });
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let ws_a = call(
        &mut ws,
        "r1",
        "workspace.open",
        json!({"path": dir_a.path().to_string_lossy()}),
    )
    .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let ws_b = call(
        &mut ws,
        "r2",
        "workspace.open",
        json!({"path": dir_b.path().to_string_lossy()}),
    )
    .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let sess_a1 = call(
        &mut ws,
        "r3",
        "session.create",
        json!({"workspaceId": ws_a}),
    )
    .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let sess_a2 = call(
        &mut ws,
        "r4",
        "session.create",
        json!({"workspaceId": ws_a}),
    )
    .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let sess_b = call(
        &mut ws,
        "r5",
        "session.create",
        json!({"workspaceId": ws_b}),
    )
    .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Start a (gated) turn in workspace A.
    let send =
        |sess: &str| json!({"sessionId": sess, "message": {"role": "user", "content": "go"}});
    let resp = call(&mut ws, "r6", "session.sendMessage", send(&sess_a1)).await;
    assert!(resp.get("result").is_some(), "first turn starts: {resp}");

    // Sending to the same session while its turn runs queues the message
    // instead of failing; it will run when the current turn ends.
    let resp = call(&mut ws, "r7", "session.sendMessage", send(&sess_a1)).await;
    assert!(
        resp["result"]["queued"].is_object(),
        "same-session message is queued: {resp}"
    );
    let queued_id = resp["result"]["queued"]["id"].as_str().unwrap().to_string();
    let resp = call(
        &mut ws,
        "r7b",
        "session.queueList",
        json!({"sessionId": sess_a1}),
    )
    .await;
    assert_eq!(resp["result"]["queue"][0]["id"], queued_id.as_str());
    // Remove it again so the release below only completes three turns.
    let resp = call(
        &mut ws,
        "r7c",
        "session.queueRemove",
        json!({"queuedMessageId": queued_id}),
    )
    .await;
    assert!(
        resp.get("result").is_some(),
        "queued message removed: {resp}"
    );

    // Another session in the SAME workspace runs in parallel.
    let resp = call(&mut ws, "r8", "session.sendMessage", send(&sess_a2)).await;
    assert!(
        resp.get("result").is_some(),
        "same-workspace session runs in parallel: {resp}"
    );

    // A session in another workspace also runs in parallel.
    let resp = call(&mut ws, "r9", "session.sendMessage", send(&sess_b)).await;
    assert!(
        resp.get("result").is_some(),
        "other workspace runs in parallel: {resp}"
    );

    // Release the gate; all three turns complete.
    release_tx.send(true).unwrap();
    let mut completed = std::collections::HashSet::new();
    while completed.len() < 3 {
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
    assert!(completed.contains(&sess_a2));
    assert!(completed.contains(&sess_b));

    // The original session is free again after its turn completes.
    let resp = call(&mut ws, "r10", "session.sendMessage", send(&sess_a1)).await;
    assert!(
        resp.get("result").is_some(),
        "session freed after turn: {resp}"
    );
    release_tx.send(true).ok();
}
