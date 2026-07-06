//! End-to-end tests for scheduled tasks over a real WebSocket connection.

use futures_util::{SinkExt, StreamExt};
use miniq_daemon::server;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_models::ChatDelta;
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type WsClient = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn start(provider: MockProvider) -> (u16, String) {
    let token = "test-token".to_string();
    let store = Store::open_in_memory().unwrap();
    let state = AppState::new(store, token.clone(), std::sync::Arc::new(provider));
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

#[tokio::test]
async fn schedule_crud_and_run_now() {
    let provider = MockProvider::new(vec![vec![ChatDelta::Text("日报写好了".into())]]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let resp = call(
        &mut ws,
        "w1",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await;
    let ws_id = resp["result"]["id"].as_str().unwrap().to_string();

    // Create a daily task.
    let resp = call(
        &mut ws,
        "s1",
        "schedule.create",
        json!({
            "workspaceId": ws_id,
            "name": "每日简报",
            "prompt": "汇总今天的进展",
            "schedule": {"type": "daily", "time": "09:00"},
        }),
    )
    .await;
    let task = &resp["result"];
    assert_eq!(task["name"], "每日简报");
    assert_eq!(task["enabled"], true);
    let task_id = task["id"].as_str().unwrap().to_string();
    assert!(task["nextRunAt"].as_str().unwrap() > miniq_memory::now_iso().as_str());

    // Bad schedule is rejected.
    let resp = call(
        &mut ws,
        "s2",
        "schedule.create",
        json!({
            "workspaceId": ws_id,
            "name": "x",
            "prompt": "y",
            "schedule": {"type": "daily", "time": "25:61"},
        }),
    )
    .await;
    assert!(resp["error"]["message"].as_str().unwrap().contains("invalid schedule"));

    // List contains the task.
    let resp = call(&mut ws, "s3", "schedule.list", Value::Null).await;
    assert_eq!(resp["result"]["tasks"].as_array().unwrap().len(), 1);

    // Run it immediately: a session is created and the turn completes.
    let resp = call(&mut ws, "s4", "schedule.runNow", json!({"id": task_id})).await;
    let session_id = resp["result"]["sessionId"].as_str().unwrap().to_string();
    next_event_of(&mut ws, "turn_completed").await;

    let resp = call(&mut ws, "s5", "session.open", json!({"sessionId": session_id})).await;
    let messages = resp["result"]["messages"].as_array().unwrap();
    assert_eq!(messages[0]["content"], "汇总今天的进展");
    assert_eq!(messages[1]["content"], "日报写好了");
    assert_eq!(resp["result"]["session"]["title"], "每日简报");

    // lastRun / lastSession recorded.
    let resp = call(&mut ws, "s6", "schedule.list", Value::Null).await;
    let task = &resp["result"]["tasks"][0];
    assert_eq!(task["lastSessionId"].as_str().unwrap(), session_id);
    assert!(task["lastRunAt"].is_string());

    // Toggle off and delete.
    let resp = call(
        &mut ws,
        "s7",
        "schedule.toggle",
        json!({"id": task_id, "enabled": false}),
    )
    .await;
    assert_eq!(resp["result"]["enabled"], false);
    let resp = call(&mut ws, "s8", "schedule.delete", json!({"id": task_id})).await;
    assert_eq!(resp["result"]["deleted"], true);
    let resp = call(&mut ws, "s9", "schedule.list", Value::Null).await;
    assert_eq!(resp["result"]["tasks"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn workspace_create_makes_blank_project() {
    let tmp = tempfile::tempdir().unwrap();
    // Point the daemon data dir at a temp location for this process.
    std::env::set_var("MINIQ_DATA_DIR", tmp.path());
    let (port, token) = start(MockProvider::text("ok")).await;
    let mut ws = connect(port, &token).await;

    let resp = call(&mut ws, "c1", "workspace.create", json!({"name": "我的新项目"})).await;
    let created = &resp["result"];
    assert_eq!(created["name"], "我的新项目");
    let path = created["path"].as_str().unwrap();
    assert!(std::path::Path::new(path).is_dir());

    // Invalid name is rejected.
    let resp = call(&mut ws, "c2", "workspace.create", json!({"name": "a/b"})).await;
    assert!(resp["error"]["message"]
        .as_str()
        .unwrap()
        .contains("invalid characters"));
}
