//! End-to-end tests for the tool + approval loop, driven by a scripted mock
//! provider over a real WebSocket connection.

use futures_util::{SinkExt, StreamExt};
use miniq_daemon::server;
use miniq_daemon::state::AppState;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_models::{ChatDelta, ToolCallRequest};
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

/// Create workspace + session; returns (session_id).
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
async fn readonly_tool_runs_without_approval() {
    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "file_read", json!({"path": "hello.txt"}))],
        vec![ChatDelta::Text("the file says hi".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hi from disk").unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "read hello.txt"}}),
    )
    .await;

    let started = next_event_of(&mut ws, "tool_call_started").await;
    assert_eq!(started["toolName"], "file_read");

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    assert_eq!(finished["output"]["content"], "hi from disk");

    let created = next_event_of(&mut ws, "message_created").await;
    assert_eq!(created["message"]["content"], "the file says hi");
    next_event_of(&mut ws, "turn_completed").await;

    // Tool call persisted.
    let resp = call(&mut ws, "r2", "session.open", json!({"sessionId": sess_id})).await;
    let calls = resp["result"]["toolCalls"].as_array().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["toolName"], "file_read");
    assert_eq!(calls[0]["status"], "succeeded");
}

#[tokio::test]
async fn write_tool_requires_approval_and_runs_after_approve() {
    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "file_write", json!({"path": "out.txt", "content": "written!"}))],
        vec![ChatDelta::Text("done".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "write out.txt"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "file_write");
    assert_eq!(requested["riskLevel"], "medium");
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();

    // File must NOT exist while waiting.
    assert!(!dir.path().join("out.txt").exists());

    let resp = call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;
    assert_eq!(resp["result"]["resolved"], true);

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;

    assert_eq!(
        std::fs::read_to_string(dir.path().join("out.txt")).unwrap(),
        "written!"
    );
}

#[tokio::test]
async fn rejected_approval_returns_structured_rejection() {
    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "file_write", json!({"path": "out.txt", "content": "nope"}))],
        vec![ChatDelta::Text("understood, not writing".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "write out.txt"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();

    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "reject"}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "rejected");
    assert_eq!(finished["output"]["rejected"], true);
    next_event_of(&mut ws, "turn_completed").await;

    assert!(!dir.path().join("out.txt").exists());
}

#[tokio::test]
async fn blocked_command_is_rejected_without_approval() {
    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "shell_run", json!({"command": "rm -rf /"}))],
        vec![ChatDelta::Text("that command is blocked".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "clean up"}}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "rejected");
    assert_eq!(finished["output"]["riskLevel"], "blocked");
    next_event_of(&mut ws, "turn_completed").await;
}

#[tokio::test]
async fn approve_for_session_skips_second_approval() {
    let provider = MockProvider::new(vec![
        // Turn 1: two writes, one after the other.
        vec![tool_call("c1", "file_write", json!({"path": "a.txt", "content": "1"}))],
        vec![tool_call("c2", "file_write", json!({"path": "b.txt", "content": "2"}))],
        vec![ChatDelta::Text("both written".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "write both"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve_for_session"}),
    )
    .await;

    // Both tool calls succeed; only one approval was ever requested.
    let f1 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f1["status"], "succeeded");
    let f2 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f2["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;

    assert!(dir.path().join("a.txt").exists());
    assert!(dir.path().join("b.txt").exists());
}

/// M1 acceptance: locate a file in an unknown directory (glob), find the
/// broken content (grep), fix it with a unique-match edit (approved), and
/// report back — the full "find and fix" loop.
#[tokio::test]
async fn locate_and_edit_in_unknown_directory() {
    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "file_glob", json!({"pattern": "**/*.md"}))],
        vec![tool_call("c2", "file_grep", json!({"pattern": "TODO"}))],
        vec![tool_call(
            "c3",
            "file_edit",
            json!({"path": "notes/plan.md", "oldString": "TODO: fill in", "newString": "Done."}),
        )],
        vec![ChatDelta::Text("fixed the TODO".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("notes")).unwrap();
    std::fs::write(dir.path().join("notes/plan.md"), "# Plan\nTODO: fill in\n").unwrap();
    std::fs::write(dir.path().join("readme.txt"), "not markdown").unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "finish the plan"}}),
    )
    .await;

    // glob + grep run without approval (low risk).
    let f1 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f1["status"], "succeeded");
    assert_eq!(f1["output"]["files"][0], "notes/plan.md");
    let f2 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f2["status"], "succeeded");
    assert_eq!(f2["output"]["matches"][0]["line"], 2);

    // edit is medium risk -> approval.
    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "file_edit");
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;
    let f3 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f3["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;

    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap(),
        "# Plan\nDone.\n"
    );
}

#[tokio::test]
async fn web_fetch_needs_domain_approval_then_session_grant_covers_same_domain() {
    // Local HTTP server the agent will fetch from.
    let app = axum::Router::new()
        .route("/a", axum::routing::get(|| async { "page A" }))
        .route("/b", axum::routing::get(|| async { "page B" }));
    let http = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let http_port = http.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(http, app).await.unwrap() });

    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "web_fetch", json!({"url": format!("http://127.0.0.1:{http_port}/a")}))],
        vec![tool_call("c2", "web_fetch", json!({"url": format!("http://127.0.0.1:{http_port}/b")}))],
        vec![ChatDelta::Text("fetched both".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "fetch pages"}}),
    )
    .await;

    // First fetch: high risk (network) -> approval with the domain visible.
    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "web_fetch");
    assert_eq!(requested["riskLevel"], "high");
    assert!(requested["approval"]["reason"]
        .as_str()
        .unwrap()
        .contains("127.0.0.1"));
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve_for_session"}),
    )
    .await;

    // Both fetches succeed; the second (same domain) required no approval.
    let f1 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f1["status"], "succeeded");
    assert!(f1["output"]["content"].as_str().unwrap().contains("page A"));
    let f2 = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(f2["status"], "succeeded");
    assert!(f2["output"]["content"].as_str().unwrap().contains("page B"));
    next_event_of(&mut ws, "turn_completed").await;
}

#[tokio::test]
async fn tool_list_reports_toolset() {
    let (port, token) = start(MockProvider::text("x")).await;
    let mut ws = connect(port, &token).await;
    let resp = call(&mut ws, "r1", "tool.list", Value::Null).await;
    let names: Vec<&str> = resp["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "ask_user",
            "doc_read",
            "doc_write",
            "file_edit",
            "file_glob",
            "file_grep",
            "file_list",
            "file_patch",
            "file_read",
            "file_write",
            "git_diff",
            "git_status",
            "http_request",
            "mcp_call",
            "memory_search",
            "memory_write",
            "shell_run",
            "skill_read",
            "task_update",
            "web_fetch",
            "web_search",
        ]
    );
}
