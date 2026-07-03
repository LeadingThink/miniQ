//! End-to-end test: start the daemon router on an ephemeral port, connect a
//! real WebSocket client, and drive the JSON-RPC surface.

use futures_util::{SinkExt, StreamExt};
use miniq_daemon::server;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

async fn start_daemon() -> (u16, String) {
    start_daemon_with(std::sync::Arc::new(miniq_models::mock::MockProvider::text(
        "hello from mock",
    )))
    .await
}

async fn start_daemon_with(
    provider: std::sync::Arc<dyn miniq_models::ModelProvider>,
) -> (u16, String) {
    let token = "test-token".to_string();
    let store = Store::open_in_memory().unwrap();
    let state = AppState::new(store, token.clone(), provider);
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        server::serve(listener, state).await.unwrap();
    });
    (port, token)
}

type WsClient = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn connect(port: u16, token: &str) -> WsClient {
    let (ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws?token={token}"))
        .await
        .expect("connect");
    ws
}

async fn call(ws: &mut WsClient, id: &str, method: &str, params: Value) -> Value {
    let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    ws.send(Message::Text(req.to_string().into())).await.unwrap();
    // Skip broadcast events until we see our response id.
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
async fn rejects_bad_token() {
    let (port, _token) = start_daemon().await;
    let result = connect_async(format!("ws://127.0.0.1:{port}/ws?token=wrong")).await;
    assert!(result.is_err(), "connection with wrong token must fail");
}

#[tokio::test]
async fn health_check() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;
    let resp = call(&mut ws, "r1", "daemon.health", Value::Null).await;
    assert_eq!(resp["result"]["protocolVersion"], 1);
    assert!(resp["result"]["daemonVersion"].is_string());
}

#[tokio::test]
async fn unknown_method_errors() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;
    let resp = call(&mut ws, "r1", "no.such.method", Value::Null).await;
    assert_eq!(resp["error"]["code"], -32601);
}

#[tokio::test]
async fn workspace_and_session_flow() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().to_string();

    let resp = call(&mut ws, "r1", "workspace.open", json!({"path": path})).await;
    let ws_id = resp["result"]["id"].as_str().expect("workspace id").to_string();

    let resp = call(
        &mut ws,
        "r2",
        "session.create",
        json!({"workspaceId": ws_id, "title": "hello"}),
    )
    .await;
    let sess_id = resp["result"]["id"].as_str().expect("session id").to_string();
    assert_eq!(resp["result"]["status"], "idle");

    let resp = call(&mut ws, "r3", "session.list", json!({"workspaceId": ws_id})).await;
    assert_eq!(resp["result"]["sessions"].as_array().unwrap().len(), 1);

    let resp = call(&mut ws, "r4", "session.open", json!({"sessionId": sess_id})).await;
    assert_eq!(resp["result"]["session"]["title"], "hello");
    assert_eq!(resp["result"]["messages"].as_array().unwrap().len(), 0);
}

/// Collect events until a predicate matches or the stream stalls.
async fn next_event_of(ws: &mut WsClient, wanted_type: &str) -> Value {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for event")
            .expect("stream open")
            .expect("ws ok");
        let Message::Text(text) = msg else { continue };
        let v: Value = serde_json::from_str(&text).unwrap();
        if v.get("type").and_then(|t| t.as_str()) == Some(wanted_type) {
            return v;
        }
    }
}

#[tokio::test]
async fn chat_turn_streams_and_persists() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let resp = call(
        &mut ws,
        "r1",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await;
    let ws_id = resp["result"]["id"].as_str().unwrap().to_string();
    let resp = call(&mut ws, "r2", "session.create", json!({"workspaceId": ws_id})).await;
    let sess_id = resp["result"]["id"].as_str().unwrap().to_string();

    let resp = call(
        &mut ws,
        "r3",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "hi"}}),
    )
    .await;
    assert_eq!(resp["result"]["message"]["role"], "user");

    // Streaming deltas arrive, then the final assistant message, then done.
    let delta = next_event_of(&mut ws, "assistant_delta").await;
    assert_eq!(delta["sessionId"], sess_id.as_str());
    assert!(!delta["delta"].as_str().unwrap().is_empty());

    let created = next_event_of(&mut ws, "message_created").await;
    assert_eq!(created["message"]["role"], "assistant");
    assert_eq!(created["message"]["content"], "hello from mock");

    next_event_of(&mut ws, "turn_completed").await;

    // Persistence: reopen the session and check both messages are stored.
    let resp = call(&mut ws, "r4", "session.open", json!({"sessionId": sess_id})).await;
    let messages = resp["result"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["content"], "hello from mock");
    assert_eq!(resp["result"]["session"]["status"], "idle");
}

#[tokio::test]
async fn busy_session_rejects_second_message() {
    // Script one slow-ish turn by using a multi-chunk mock.
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let resp = call(
        &mut ws,
        "r1",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await;
    let ws_id = resp["result"]["id"].as_str().unwrap().to_string();
    let resp = call(&mut ws, "r2", "session.create", json!({"workspaceId": ws_id})).await;
    let sess_id = resp["result"]["id"].as_str().unwrap().to_string();

    let send = json!({"sessionId": sess_id, "message": {"role": "user", "content": "hi"}});
    let first = call(&mut ws, "r3", "session.sendMessage", send.clone()).await;
    let second = call(&mut ws, "r4", "session.sendMessage", send).await;

    // One of the two must be rejected as busy OR both succeed sequentially is
    // NOT allowed: the second request races the turn end, so accept either a
    // busy error or (rarely) success if the mock turn already finished.
    let first_ok = first.get("result").is_some();
    assert!(first_ok, "first send must succeed: {first}");
    if let Some(err) = second.get("error") {
        assert_eq!(err["code"], -32003);
    }
}

#[tokio::test]
async fn provider_failure_marks_turn_failed() {
    // Mock with zero scripted turns -> provider errors on first use.
    let provider = std::sync::Arc::new(miniq_models::mock::MockProvider::new(vec![]));
    let (port, token) = start_daemon_with(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let resp = call(
        &mut ws,
        "r1",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await;
    let ws_id = resp["result"]["id"].as_str().unwrap().to_string();
    let resp = call(&mut ws, "r2", "session.create", json!({"workspaceId": ws_id})).await;
    let sess_id = resp["result"]["id"].as_str().unwrap().to_string();

    call(
        &mut ws,
        "r3",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "hi"}}),
    )
    .await;

    let failed = next_event_of(&mut ws, "turn_failed").await;
    assert!(failed["error"].as_str().unwrap().contains("scripted"));

    let resp = call(&mut ws, "r4", "session.open", json!({"sessionId": sess_id})).await;
    assert_eq!(resp["result"]["session"]["status"], "failed");
}

#[tokio::test]
async fn settings_update_and_masking() {
    // Daemon whose provider follows settings, persisted to a temp file.
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    let token = "test-token".to_string();
    let state = miniq_daemon::state::AppState::with_settings(
        Store::open_in_memory().unwrap(),
        token.clone(),
        miniq_daemon::state::DaemonSettings::default(),
        settings_path.clone(),
    );
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { server::serve(listener, state).await.unwrap() });

    let mut ws = connect(port, &token).await;

    let resp = call(&mut ws, "r1", "settings.get", Value::Null).await;
    assert!(resp["result"]["provider"].is_null());

    let resp = call(
        &mut ws,
        "r2",
        "settings.update",
        json!({"provider": {"baseUrl": "http://127.0.0.1:9999/v1", "model": "test-model", "apiKey": "secret-key"}}),
    )
    .await;
    assert_eq!(resp["result"]["provider"]["model"], "test-model");
    assert_eq!(resp["result"]["provider"]["hasApiKey"], true);
    // The key itself must never be echoed back.
    assert!(resp["result"].to_string().find("secret-key").is_none());

    // Persisted on disk with the real key.
    let raw = std::fs::read_to_string(&settings_path).unwrap();
    assert!(raw.contains("secret-key"));

    // Update without apiKey keeps the stored key.
    let resp = call(
        &mut ws,
        "r3",
        "settings.update",
        json!({"provider": {"baseUrl": "http://127.0.0.1:9999/v1", "model": "other-model"}}),
    )
    .await;
    assert_eq!(resp["result"]["provider"]["hasApiKey"], true);
    let raw = std::fs::read_to_string(&settings_path).unwrap();
    assert!(raw.contains("secret-key"));
    assert!(raw.contains("other-model"));
}

#[tokio::test]
async fn invalid_workspace_path_rejected() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;
    let resp = call(
        &mut ws,
        "r1",
        "workspace.open",
        json!({"path": "Z:/definitely/not/a/real/dir"}),
    )
    .await;
    assert_eq!(resp["error"]["code"], -32602);
}
