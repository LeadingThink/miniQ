//! M2 acceptance: skills are advertised in the system prompt, readable via
//! the skill_read tool, and toggling enabled state takes effect immediately.

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

type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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
    let resp = call(
        ws,
        "setup2",
        "session.create",
        json!({"workspaceId": ws_id}),
    )
    .await;
    resp["result"]["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn skill_rpcs_list_read_toggle_delete() {
    let provider = Arc::new(MockProvider::text("x"));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    // Bundled skills are discovered.
    let resp = call(&mut ws, "r1", "skill.list", json!({})).await;
    let skills = resp["result"]["skills"].as_array().unwrap();
    let names: Vec<&str> = skills.iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"organize-directory"));
    assert!(names.contains(&"summarize-changes"));
    assert!(skills.iter().all(|s| s["enabled"] == true));

    // Read returns the body.
    let resp = call(
        &mut ws,
        "r2",
        "skill.read",
        json!({"name": "organize-directory"}),
    )
    .await;
    assert!(resp["result"]["body"]
        .as_str()
        .unwrap()
        .contains("file_glob"));
    assert_eq!(resp["result"]["source"], "bundled");

    // Toggle off is reflected in the next list.
    call(
        &mut ws,
        "r3",
        "skill.setEnabled",
        json!({"name": "organize-directory", "enabled": false}),
    )
    .await;
    let resp = call(&mut ws, "r4", "skill.list", json!({})).await;
    let disabled = resp["result"]["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "organize-directory")
        .unwrap();
    assert_eq!(disabled["enabled"], false);

    // Bundled skills cannot be deleted.
    let resp = call(
        &mut ws,
        "r5",
        "skill.delete",
        json!({"name": "organize-directory"}),
    )
    .await;
    assert!(resp["error"]["message"]
        .as_str()
        .unwrap()
        .contains("only user skills"));
}

#[tokio::test]
async fn skill_import_rpc_installs_and_updates_a_package() {
    let provider = Arc::new(MockProvider::text("x"));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;
    let package = tempfile::tempdir().unwrap();
    let skill = package.path().join("document-workflow");
    std::fs::create_dir_all(skill.join("scripts")).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: document-workflow\ndisplayName: 文档工作流\ndescription: imported docs\nversion: 2\n---\n\nUse doc_read.\n",
    )
    .unwrap();
    std::fs::write(skill.join("scripts/check.sh"), "echo ok").unwrap();

    let response = call(
        &mut ws,
        "import",
        "skill.import",
        json!({"path": package.path().to_string_lossy()}),
    )
    .await;
    assert_eq!(
        response["result"]["imported"][0]["name"],
        "document-workflow"
    );
    assert_eq!(response["result"]["imported"][0]["version"], 2);
    assert_eq!(
        response["result"]["imported"][0]["displayName"],
        "文档工作流"
    );
    let detail = call(
        &mut ws,
        "read-imported",
        "skill.read",
        json!({"name": "document-workflow"}),
    )
    .await;
    let listed = call(&mut ws, "list-imported", "skill.list", json!({})).await;
    let listed_skill = listed["result"]["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|skill| skill["name"] == "document-workflow")
        .unwrap();
    assert_eq!(listed_skill["displayName"], "文档工作流");
    assert_eq!(detail["result"]["displayName"], "文档工作流");
    assert_eq!(detail["result"]["files"][0], "scripts/check.sh");

    // Older packages omit the optional label in both RPC response shapes.
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: document-workflow\ndescription: legacy docs\nversion: 3\n---\nLegacy body.\n",
    )
    .unwrap();
    let updated = call(
        &mut ws,
        "import-legacy",
        "skill.import",
        json!({"path": package.path().to_string_lossy()}),
    )
    .await;
    assert!(updated.get("error").is_none());
    let legacy_list = call(&mut ws, "list-legacy", "skill.list", json!({})).await;
    let legacy_skill = legacy_list["result"]["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|skill| skill["name"] == "document-workflow")
        .unwrap();
    assert_eq!(legacy_skill["version"], 3);
    assert!(legacy_skill.get("displayName").is_none());
    let legacy_read = call(
        &mut ws,
        "read-legacy",
        "skill.read",
        json!({"name": "document-workflow"}),
    )
    .await;
    assert_eq!(legacy_read["result"]["name"], "document-workflow");
    assert_eq!(legacy_read["result"]["version"], 3);
    assert!(legacy_read["result"].get("displayName").is_none());
}

#[tokio::test]
async fn skills_injected_into_prompt_and_readable_by_agent() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "c1".into(),
            name: "skill_read".into(),
            arguments: json!({"name": "organize-directory"}),
        })],
        vec![ChatDelta::Text("following the skill".into())],
    ]));
    let (port, token) = start(provider.clone()).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "盘点这个目录"}}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    assert!(finished["output"]["body"]
        .as_str()
        .unwrap()
        .contains("file_glob"));
    next_event_of(&mut ws, "turn_completed").await;

    // The system prompt advertised the skills.
    let requests = provider.requests.lock().unwrap();
    let system = &requests[0].messages[0];
    assert!(system.content.contains("<available_skills>"));
    assert!(system.content.contains("organize-directory"));
    assert!(system.content.contains("summarize-changes"));
}

#[tokio::test]
async fn disabled_skill_leaves_prompt() {
    let provider = Arc::new(MockProvider::new(vec![vec![ChatDelta::Text("ok".into())]]));
    let (port, token) = start(provider.clone()).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let sess_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "skill.setEnabled",
        json!({"name": "organize-directory", "enabled": false}),
    )
    .await;
    call(
        &mut ws,
        "r2",
        "session.sendMessage",
        json!({"sessionId": sess_id, "message": {"role": "user", "content": "hi"}}),
    )
    .await;
    next_event_of(&mut ws, "turn_completed").await;

    let requests = provider.requests.lock().unwrap();
    let system = &requests[0].messages[0];
    assert!(!system.content.contains("organize-directory"));
    assert!(system.content.contains("summarize-changes"));
}

#[tokio::test]
async fn skill_create_drafts_without_installing_and_validate_flags_secrets() {
    let draft = "---\nname: weekly-report\ndisplayName: 周报整理\ndescription: 汇总本周提交并生成周报草稿，用户要求写周报时使用\nversion: 1\norigin: user\n---\n\n## 步骤\n1. 用 shell_run 读取本周 git log。\n2. 用 doc_write 写周报。\n\n## 如何确认完成\n周报包含本周每个工作日。\n";
    let provider = Arc::new(MockProvider::text(draft));
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let started = call(
        &mut ws,
        "create",
        "skill.create",
        json!({"goal": "每周五整理周报"}),
    )
    .await;
    let job_id = started["result"]["id"].as_str().unwrap().to_owned();
    let created = loop {
        let status = call(
            &mut ws,
            "create-status",
            "skill.job.get",
            json!({"jobId": job_id}),
        )
        .await;
        match status["result"]["state"].as_str() {
            Some("completed") => break status["result"]["result"].clone(),
            Some("failed") | Some("cancelled") => panic!("skill create job failed: {status}"),
            _ => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
        }
    };
    assert_eq!(created["name"], "weekly-report");
    assert_eq!(created["validation"]["valid"], true);
    // Drafting never installs: the skill is absent until skill.save.
    let listed = call(&mut ws, "list", "skill.list", json!({})).await;
    assert!(!listed["result"]["skills"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["name"] == "weekly-report"));

    let short = call(&mut ws, "short", "skill.create", json!({"goal": "  a "})).await;
    assert!(short["error"].is_object());

    let secret = draft.replace("本周提交", "api_key=sk-abcdefghijklmnopqrstu");
    let checked = call(
        &mut ws,
        "validate",
        "skill.validate",
        json!({"content": secret}),
    )
    .await;
    assert_eq!(checked["result"]["valid"], false);
    assert!(checked["result"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == "secrets" && c["level"] == "error"));
}
