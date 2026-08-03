use futures_util::{SinkExt, StreamExt};
use miniq_daemon::server;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_models::{ChatDelta, ToolCallRequest};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

pub(crate) type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(crate) async fn start(provider: MockProvider) -> (u16, String) {
    let token = "test-token".to_string();
    let store = Store::open_in_memory().unwrap();
    let state = AppState::new(store, token.clone(), std::sync::Arc::new(provider));
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { server::serve(listener, state).await.unwrap() });
    (port, token)
}

pub(crate) async fn connect(port: u16, token: &str) -> WsClient {
    let (ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws?token={token}"))
        .await
        .expect("connect");
    ws
}

pub(crate) async fn call(ws: &mut WsClient, id: &str, method: &str, params: Value) -> Value {
    let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    ws.send(Message::Text(req.to_string().into()))
        .await
        .unwrap();
    loop {
        let msg = ws.next().await.expect("stream open").expect("ws ok");
        let Message::Text(text) = msg else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value.get("id").and_then(|response_id| response_id.as_str()) == Some(id) {
            return value;
        }
    }
}

pub(crate) async fn next_event_of(ws: &mut WsClient, wanted: &str) -> Value {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {wanted}"))
            .expect("stream open")
            .expect("ws ok");
        let Message::Text(text) = msg else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value.get("type").and_then(|event_type| event_type.as_str()) == Some(wanted) {
            return value;
        }
    }
}

pub(crate) async fn setup_session(ws: &mut WsClient, dir: &std::path::Path) -> String {
    let response = call(
        ws,
        "setup1",
        "workspace.open",
        json!({"path": dir.to_string_lossy()}),
    )
    .await;
    let workspace_id = response["result"]["id"].as_str().unwrap().to_string();
    let response = call(
        ws,
        "setup2",
        "session.create",
        json!({"workspaceId": workspace_id}),
    )
    .await;
    response["result"]["id"].as_str().unwrap().to_string()
}

pub(crate) fn tool_call(id: &str, name: &str, arguments: Value) -> ChatDelta {
    ChatDelta::ToolCall(ToolCallRequest {
        id: id.to_string(),
        name: name.to_string(),
        arguments,
    })
}
