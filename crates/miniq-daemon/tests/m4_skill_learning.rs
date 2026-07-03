//! M4 acceptance: complete a multi-step task, distill it into a skill with
//! one call, save it, see it advertised in the next turn, and refine it
//! after a repeat run.

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

const DISTILLED: &str = "---\nname: inventory-report\ndescription: 盘点目录并生成清单\nversion: 1\norigin: distilled\n---\n\n## 步骤\n1. 用 file_glob 找到所有文件\n2. 用 file_write 写 inventory.md\n";

#[tokio::test]
async fn full_learning_loop() {
    // Scripted provider turns, in order:
    // 1-2: the original task (glob -> final text)
    // 3:   distillation -> SKILL.md
    // 4:   second session turn (must see the skill advertised)
    // 5:   refinement -> updated SKILL.md v2
    let updated = DISTILLED.replace("version: 1", "version: 2");
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "c1".into(),
            name: "file_glob".into(),
            arguments: json!({"pattern": "**/*"}),
        })],
        vec![ChatDelta::Text("盘点完成".into())],
        vec![ChatDelta::Text(DISTILLED.into())],
        vec![ChatDelta::Text("ok".into())],
        vec![ChatDelta::Text(updated.clone())],
    ]));
    let (port, token) = start(provider.clone()).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "x").unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    // 1. Run the original task.
    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "盘点这个目录"}}),
    )
    .await;
    next_event_of(&mut ws, "turn_completed").await;

    // 2. Distill it.
    let resp = call(&mut ws, "r2", "skill.distill", json!({"sessionId": sess_id})).await;
    assert_eq!(resp["result"]["skipped"], false);
    assert_eq!(resp["result"]["name"], "inventory-report");
    assert_eq!(resp["result"]["existingSkill"], false);
    assert!(resp["result"]["warnings"].as_array().unwrap().is_empty());
    let content = resp["result"]["content"].as_str().unwrap().to_string();

    // The distillation prompt received the real transcript.
    {
        let requests = provider.requests.lock().unwrap();
        let distill_user = &requests[2].messages[1].content;
        assert!(distill_user.contains("file_glob"));
        assert!(distill_user.contains("盘点这个目录"));
    }

    // 3. Save it.
    let resp = call(&mut ws, "r3", "skill.save", json!({"content": content})).await;
    assert_eq!(resp["result"]["name"], "inventory-report");

    // 4. New session: the skill is advertised in the system prompt.
    let ws_resp = call(
        &mut ws,
        "r4b",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await;
    let ws_id = ws_resp["result"]["id"].as_str().unwrap().to_string();
    let resp = call(&mut ws, "r4", "session.create", json!({"workspaceId": ws_id})).await;
    let sess2 = resp["result"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r5",
        "session.sendMessage",
        json!({"sessionId": sess2, "message": {"role": "user", "content": "再盘点一次"}}),
    )
    .await;
    next_event_of(&mut ws, "turn_completed").await;
    {
        let requests = provider.requests.lock().unwrap();
        let system = &requests[3].messages[0].content;
        assert!(system.contains("inventory-report"), "learned skill must be advertised");
    }

    // 5. Refine from the repeat session.
    let resp = call(
        &mut ws,
        "r6",
        "skill.refine",
        json!({"sessionId": sess2, "name": "inventory-report"}),
    )
    .await;
    assert_eq!(resp["result"]["kept"], false);
    let refined = resp["result"]["content"].as_str().unwrap().to_string();
    assert!(refined.contains("version: 2"));
    let resp = call(&mut ws, "r7", "skill.save", json!({"content": refined})).await;
    assert_eq!(resp["result"]["version"], 2);

    // The stored skill is now v2.
    let resp = call(&mut ws, "r8", "skill.read", json!({"name": "inventory-report"})).await;
    assert_eq!(resp["result"]["version"], 2);
    assert_eq!(resp["result"]["source"], "user");
}

#[tokio::test]
async fn distill_skip_and_sensitive_save_guard() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::Text("你好!".into())],
        vec![ChatDelta::Text("SKIP: pure question answering".into())],
    ]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;
    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "你好"}}),
    )
    .await;
    next_event_of(&mut ws, "turn_completed").await;

    let resp = call(&mut ws, "r2", "skill.distill", json!({"sessionId": sess_id})).await;
    assert_eq!(resp["result"]["skipped"], true);
    assert!(resp["result"]["reason"].as_str().unwrap().contains("question"));

    // Saving a draft with an embedded key is rejected unless forced.
    let dirty = "---\nname: leaky-skill\ndescription: leaks\n---\n\n## 步骤\napi_key = \"sk-abcdefghijklmnop1234\"\n";
    let resp = call(&mut ws, "r3", "skill.save", json!({"content": dirty})).await;
    assert!(resp["error"]["message"].as_str().unwrap().contains("sensitive"));
    assert!(!resp["error"]["data"]["warnings"].as_array().unwrap().is_empty());

    let resp = call(&mut ws, "r4", "skill.save", json!({"content": dirty, "force": true})).await;
    assert_eq!(resp["result"]["name"], "leaky-skill");
}

#[tokio::test]
async fn distill_requires_completed_turn() {
    let provider = Arc::new(MockProvider::new(vec![]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;
    let resp = call(&mut ws, "r1", "skill.distill", json!({"sessionId": sess_id})).await;
    assert!(resp["error"]["message"]
        .as_str()
        .unwrap()
        .contains("no completed turn"));
}
