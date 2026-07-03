//! M6 acceptance (MCP): configure a server, list its tools, and call a tool
//! through the agent with the normal approval chain.

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

fn mock_mcp_path() -> String {
    env!("CARGO_BIN_EXE_mock-mcp").to_string()
}

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
        let msg = tokio::time::timeout(std::time::Duration::from_secs(10), ws.next())
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

#[tokio::test]
async fn mcp_configure_list_and_call_through_agent() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "c1".into(),
            name: "mcp_call".into(),
            arguments: json!({"server": "mock", "tool": "echo", "arguments": {"message": "hello mcp"}}),
        })],
        vec![ChatDelta::Text("mcp done".into())],
    ]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    // Configure the mock server.
    let resp = call(
        &mut ws,
        "r1",
        "mcp.update",
        json!({"servers": [{"name": "mock", "command": mock_mcp_path(), "args": [], "enabled": true}]}),
    )
    .await;
    assert_eq!(resp["result"]["ok"], true);

    // List with live connection: server initializes and reports its tools.
    let resp = call(&mut ws, "r2", "mcp.list", json!({"connect": true})).await;
    let servers = resp["result"]["servers"].as_array().unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0]["status"], "running", "server should be running: {:?}", servers[0]);
    assert_eq!(servers[0]["tools"][0]["name"], "echo");

    // Agent calls the MCP tool; high risk -> approval scoped to the server.
    let dir = tempfile::tempdir().unwrap();
    let ws_id = call(&mut ws, "r3", "workspace.open", json!({"path": dir.path().to_string_lossy()}))
        .await["result"]["id"].as_str().unwrap().to_string();
    let sess_id = call(&mut ws, "r4", "session.create", json!({"workspaceId": ws_id}))
        .await["result"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r5",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "call the mcp tool"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "mcp_call");
    assert_eq!(requested["riskLevel"], "high");
    assert!(requested["approval"]["reason"].as_str().unwrap().contains("mock"));
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r6",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    let content = finished["output"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(content, "echo: hello mcp");
    next_event_of(&mut ws, "turn_completed").await;
}

#[tokio::test]
async fn mcp_unknown_server_reports_error() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "c1".into(),
            name: "mcp_call".into(),
            arguments: json!({"server": "nope", "tool": "echo"}),
        })],
        vec![ChatDelta::Text("ok".into())],
    ]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    call(
        &mut ws,
        "r1",
        "mcp.update",
        json!({"servers": [{"name": "mock", "command": mock_mcp_path(), "args": []}]}),
    )
    .await;

    let dir = tempfile::tempdir().unwrap();
    let ws_id = call(&mut ws, "r2", "workspace.open", json!({"path": dir.path().to_string_lossy()}))
        .await["result"]["id"].as_str().unwrap().to_string();
    let sess_id = call(&mut ws, "r3", "session.create", json!({"workspaceId": ws_id}))
        .await["result"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r4",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "call"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r5",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "failed");
    assert!(finished["output"]["error"].as_str().unwrap().contains("unknown MCP server"));
    next_event_of(&mut ws, "turn_completed").await;
}
