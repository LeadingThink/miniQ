//! Message queue acceptance: messages sent during an active turn are queued
//! and drained automatically; steering promotes a queued message and
//! interrupts the running turn.

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

/// Provider that blocks until released via a watch channel; every release
/// completes exactly one waiting turn.
struct GatedProvider {
    release: tokio::sync::watch::Receiver<u64>,
}

#[async_trait::async_trait]
impl ModelProvider for GatedProvider {
    async fn stream_complete(
        &self,
        _request: miniq_models::CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let mut release = self.release.clone();
        let seen = *release.borrow();
        while *release.borrow() == seen {
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

async fn next_event_of(ws: &mut WsClient, kind: &str) -> Value {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("event arrives")
            .unwrap()
            .unwrap();
        let Message::Text(text) = msg else { continue };
        let v: Value = serde_json::from_str(&text).unwrap();
        if v.get("type").and_then(|t| t.as_str()) == Some(kind) {
            return v;
        }
    }
}

async fn setup_session(ws: &mut WsClient) -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = call(
        ws,
        "s1",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let session = call(
        ws,
        "s2",
        "session.create",
        json!({"workspaceId": workspace}),
    )
    .await["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    (session, dir)
}

fn send_params(session: &str, content: &str) -> Value {
    json!({"sessionId": session, "message": {"role": "user", "content": content}})
}

#[tokio::test]
async fn queued_message_runs_after_turn_completes() {
    let (release_tx, release_rx) = tokio::sync::watch::channel(0u64);
    let provider: Arc<dyn ModelProvider> = Arc::new(GatedProvider {
        release: release_rx,
    });
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;
    let (session, _dir) = setup_session(&mut ws).await;

    // First message starts the (gated) turn; second is queued.
    let resp = call(
        &mut ws,
        "r1",
        "session.sendMessage",
        send_params(&session, "one"),
    )
    .await;
    assert!(resp["result"]["message"].is_object(), "starts turn: {resp}");
    let resp = call(
        &mut ws,
        "r2",
        "session.sendMessage",
        send_params(&session, "two"),
    )
    .await;
    assert!(resp["result"]["queued"].is_object(), "queued: {resp}");

    // Release the first turn; the queued message must start a second turn
    // automatically (its user message is persisted + a queue_changed event).
    release_tx.send(1).unwrap();
    next_event_of(&mut ws, "turn_completed").await;
    let queue_changed = next_event_of(&mut ws, "queue_changed").await;
    assert_eq!(queue_changed["queue"].as_array().unwrap().len(), 0);

    // Release the drained turn and wait for it to complete.
    release_tx.send(2).unwrap();
    next_event_of(&mut ws, "turn_completed").await;

    let resp = call(&mut ws, "r3", "session.open", json!({"sessionId": session})).await;
    let messages = resp["result"]["messages"].as_array().unwrap();
    let users: Vec<_> = messages.iter().filter(|m| m["role"] == "user").collect();
    assert_eq!(users.len(), 2);
    assert_eq!(users[1]["content"], "two");
    assert_eq!(resp["result"]["session"]["status"], "idle");
}

#[tokio::test]
async fn steer_interrupts_running_turn_and_promotes_message() {
    let (release_tx, release_rx) = tokio::sync::watch::channel(0u64);
    let provider: Arc<dyn ModelProvider> = Arc::new(GatedProvider {
        release: release_rx,
    });
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;
    let (session, _dir) = setup_session(&mut ws).await;

    let resp = call(
        &mut ws,
        "r1",
        "session.sendMessage",
        send_params(&session, "slow task"),
    )
    .await;
    assert!(resp["result"]["message"].is_object());
    let resp = call(
        &mut ws,
        "r2",
        "session.sendMessage",
        send_params(&session, "queued a"),
    )
    .await;
    let queued_a = resp["result"]["queued"]["id"].as_str().unwrap().to_string();
    let resp = call(
        &mut ws,
        "r3",
        "session.sendMessage",
        send_params(&session, "steer me"),
    )
    .await;
    let steer_id = resp["result"]["queued"]["id"].as_str().unwrap().to_string();

    // Steering promotes "steer me" ahead of "queued a" and cancels the turn.
    let resp = call(
        &mut ws,
        "r4",
        "session.queueSteer",
        json!({"queuedMessageId": steer_id}),
    )
    .await;
    assert_eq!(resp["result"]["interrupted"], true, "interrupts: {resp}");

    // The cancelled turn ends, then the steered message starts its turn.
    next_event_of(&mut ws, "turn_failed").await; // "cancelled"
    let queue_changed = next_event_of(&mut ws, "queue_changed").await;
    let queue = queue_changed["queue"].as_array().unwrap();
    assert_eq!(queue.len(), 1, "only 'queued a' remains: {queue_changed}");
    assert_eq!(queue[0]["id"], queued_a.as_str());

    // Finish the steered turn, then the remaining queued turn.
    release_tx.send(1).unwrap();
    next_event_of(&mut ws, "turn_completed").await;
    release_tx.send(2).unwrap();
    next_event_of(&mut ws, "turn_completed").await;

    let resp = call(&mut ws, "r5", "session.open", json!({"sessionId": session})).await;
    let users: Vec<String> = resp["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| m["content"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(users, vec!["slow task", "steer me", "queued a"]);
}

#[tokio::test]
async fn cancel_discards_queued_messages() {
    let (release_tx, release_rx) = tokio::sync::watch::channel(0u64);
    let provider: Arc<dyn ModelProvider> = Arc::new(GatedProvider {
        release: release_rx,
    });
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;
    let (session, _dir) = setup_session(&mut ws).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        send_params(&session, "task"),
    )
    .await;
    call(
        &mut ws,
        "r2",
        "session.sendMessage",
        send_params(&session, "follow-up"),
    )
    .await;

    let resp = call(
        &mut ws,
        "r3",
        "session.cancel",
        json!({"sessionId": session}),
    )
    .await;
    assert_eq!(resp["result"]["cancelled"], true);

    next_event_of(&mut ws, "turn_failed").await; // "cancelled"

    // No queued turn may start: the queue was discarded by the stop.
    let resp = call(
        &mut ws,
        "r4",
        "session.queueList",
        json!({"sessionId": session}),
    )
    .await;
    assert_eq!(resp["result"]["queue"].as_array().unwrap().len(), 0);
    let resp = call(&mut ws, "r5", "session.open", json!({"sessionId": session})).await;
    let users: Vec<_> = resp["result"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .collect();
    assert_eq!(users.len(), 1, "follow-up was discarded");
    release_tx.send(1).ok();
}
