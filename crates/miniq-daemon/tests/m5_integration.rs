//! M5 acceptance: memory tools through the full approval chain, and the
//! skill-suggestion nudge after tool-heavy sessions.

use futures_util::{SinkExt, StreamExt};
use miniq_daemon::server;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_models::{ChatDelta, ToolCallRequest};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type WsClient = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn start(provider: Arc<MockProvider>) -> (u16, String) {
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

async fn next_event_of(ws: &mut WsClient, wanted: &str) -> Value {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {wanted}"))
            .expect("stream open")
            .expect("ws ok");
        let Message::Text(text) = msg else { continue };
        let v: Value = serde_json::from_str(&text).unwrap();
        if v.get("type").and_then(|t| t.as_str()) == Some(wanted) {
            return v;
        }
    }
}

async fn setup_session(ws: &mut WsClient, dir: &std::path::Path) -> String {
    let resp = call(
        ws,
        "setup1",
        "workspace.open",
        json!({"path": dir.to_string_lossy()}),
    )
    .await;
    let ws_id = resp["result"]["id"].as_str().unwrap().to_string();
    let resp = call(ws, "setup2", "session.create", json!({"workspaceId": ws_id})).await;
    resp["result"]["id"].as_str().unwrap().to_string()
}

fn tool_call(id: &str, name: &str, arguments: Value) -> ChatDelta {
    ChatDelta::ToolCall(ToolCallRequest {
        id: id.to_string(),
        name: name.to_string(),
        arguments,
    })
}

#[tokio::test]
async fn memory_write_needs_approval_then_search_finds_it() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "memory_write",
            json!({"scope": "workspace", "content": "构建命令是 npm run build"}),
        )],
        vec![tool_call("c2", "memory_search", json!({"query": "构建"}))],
        vec![ChatDelta::Text("已记住".into())],
    ]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "记住构建命令"}}),
    )
    .await;

    // memory_write is medium risk -> approval.
    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "memory_write");
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;

    let f1 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f1["status"], "succeeded");

    // memory_search runs without approval and finds the stored fact.
    let f2 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f2["status"], "succeeded");
    let memories = f2["output"]["memories"].as_array().unwrap();
    assert_eq!(memories.len(), 1);
    assert!(memories[0]["content"].as_str().unwrap().contains("npm run build"));
    next_event_of(&mut ws, "turn_completed").await;
}

#[tokio::test]
async fn tool_heavy_session_triggers_skill_suggestion() {
    // Six read-only calls, no skill_read -> suggestion after the turn.
    let calls: Vec<Vec<ChatDelta>> = (0..6)
        .map(|i| vec![tool_call(&format!("c{i}"), "file_list", json!({}))])
        .collect();
    let mut turns = calls;
    turns.push(vec![ChatDelta::Text("done".into())]);
    let provider = Arc::new(MockProvider::new(turns));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "盘点"}}),
    )
    .await;

    let suggested = next_event_of(&mut ws, "skill_suggested").await;
    assert_eq!(suggested["sessionId"], sess_id.as_str());
    assert_eq!(suggested["toolSequence"].as_array().unwrap().len(), 6);
    next_event_of(&mut ws, "turn_completed").await;
}

#[tokio::test]
async fn short_session_gets_no_suggestion() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![tool_call("c1", "file_list", json!({}))],
        vec![ChatDelta::Text("done".into())],
    ]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;
    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "看一眼"}}),
    )
    .await;

    // turn_completed must arrive WITHOUT a preceding skill_suggested.
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("timeout")
            .unwrap()
            .unwrap();
        let Message::Text(text) = msg else { continue };
        let v: Value = serde_json::from_str(&text).unwrap();
        match v.get("type").and_then(|t| t.as_str()) {
            Some("skill_suggested") => panic!("unexpected suggestion for a short session"),
            Some("turn_completed") => break,
            _ => {}
        }
    }
}
