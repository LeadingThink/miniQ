//! M3 acceptance: plan display, clarifying questions, document deliverables
//! with artifacts, and checkpoint rollback.

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
async fn plan_document_artifact_flow() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "task_update",
            json!({"tasks": [
                {"content": "读取数据", "status": "completed"},
                {"content": "生成报告", "status": "in_progress"},
            ]}),
        )],
        vec![tool_call(
            "c2",
            "doc_write",
            json!({"path": "out/report.docx", "content": "# 摘要\n一切正常。", "title": "数据摘要报告"}),
        )],
        vec![ChatDelta::Text("报告已生成".into())],
    ]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "写份报告"}}),
    )
    .await;

    // Plan is published.
    let plan = next_event_of(&mut ws, "plan_updated").await;
    assert_eq!(plan["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(plan["tasks"][1]["status"], "in_progress");

    // doc_write needs approval (medium).
    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "doc_write");
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;

    // Artifact event fires and the file exists.
    let artifact = next_event_of(&mut ws, "artifact_created").await;
    assert_eq!(artifact["artifact"]["title"], "数据摘要报告");
    assert_eq!(artifact["artifact"]["kind"], "docx");
    next_event_of(&mut ws, "turn_completed").await;
    assert!(dir.path().join("out/report.docx").exists());

    // session.open returns plan and artifacts.
    let resp = call(&mut ws, "r3", "session.open", json!({"sessionId": sess_id})).await;
    assert_eq!(resp["result"]["plan"].as_array().unwrap().len(), 2);
    let artifacts = resp["result"]["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["path"], "out/report.docx");
}

#[tokio::test]
async fn ask_user_waits_for_answer() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "ask_user",
            json!({"prompt": "报告用中文还是英文?", "options": ["中文", "English"]}),
        )],
        vec![ChatDelta::Text("好的,用中文".into())],
    ]));
    let (port, token) = start(provider.clone()).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "写报告"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "question_requested").await;
    assert_eq!(requested["question"]["prompt"], "报告用中文还是英文?");
    assert_eq!(requested["question"]["options"][0], "中文");
    let question_id = requested["question"]["id"].as_str().unwrap().to_string();

    call(
        &mut ws,
        "r2",
        "question.resolve",
        json!({"questionId": question_id, "answer": "中文"}),
    )
    .await;

    let resolved = next_event_of(&mut ws, "question_resolved").await;
    assert_eq!(resolved["answer"], "中文");
    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["output"]["answer"], "中文");
    next_event_of(&mut ws, "turn_completed").await;

    // The answer reached the model as the tool result.
    let requests = provider.requests.lock().unwrap();
    let tool_msg = requests[1]
        .messages
        .iter()
        .find(|m| m.tool_call_id.is_some())
        .unwrap();
    assert!(tool_msg.content.contains("中文"));
}

#[tokio::test]
async fn checkpoint_rollback_restores_file() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "file_write",
            json!({"path": "notes.txt", "content": "OVERWRITTEN"}),
        )],
        vec![ChatDelta::Text("written".into())],
    ]));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("notes.txt"), "original content").unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "overwrite it"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    let checkpoint_id = finished["output"]["checkpointId"]
        .as_str()
        .expect("write tool output carries checkpointId")
        .to_string();
    next_event_of(&mut ws, "turn_completed").await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes.txt")).unwrap(),
        "OVERWRITTEN"
    );

    // Roll back to the original.
    let resp = call(
        &mut ws,
        "r3",
        "checkpoint.rollback",
        json!({"checkpointId": checkpoint_id}),
    )
    .await;
    assert_eq!(resp["result"]["existedBefore"], true);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes.txt")).unwrap(),
        "original content"
    );
}

#[tokio::test]
async fn rollback_removes_file_that_did_not_exist() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "file_write",
            json!({"path": "brand-new.txt", "content": "hello"}),
        )],
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
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "create it"}}),
    )
    .await;
    let requested = next_event_of(&mut ws, "approval_requested").await;
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;
    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    let checkpoint_id = finished["output"]["checkpointId"].as_str().unwrap().to_string();
    next_event_of(&mut ws, "turn_completed").await;
    assert!(dir.path().join("brand-new.txt").exists());

    call(
        &mut ws,
        "r3",
        "checkpoint.rollback",
        json!({"checkpointId": checkpoint_id}),
    )
    .await;
    assert!(!dir.path().join("brand-new.txt").exists());
}
