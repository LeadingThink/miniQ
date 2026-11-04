//! An opt-in local UI fixture. No provider, user data or real tool is contacted.
//! Run with TERM=xterm-256color and `cargo test -p miniq-cli --bin miniq
//! repl::live_preview::interactive -- --ignored --nocapture --test-threads=1`.
use super::*;
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an interactive terminal; use for manual TUI verification"]
async fn interactive() {
    assert!(supported(), "run this fixture in a terminal with TERM set");
    let directory = tempfile::tempdir().unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    std::fs::write(
        directory.path().join("terminal-update.json"),
        json!({"checkedAt":now,"latestVersion":env!("CARGO_PKG_VERSION")}).to_string(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    miniq_local::write_connection_info(
        directory.path(),
        &miniq_local::ConnectionInfo::current(
            listener.local_addr().unwrap().port(),
            "local-ui-fixture".into(),
        )
        .unwrap(),
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut model = "Claude Sonnet".to_owned();
        let mut history = Vec::<Value>::new();
        while let Some(Ok(Message::Text(data))) = socket.next().await {
            let request: Value = serde_json::from_str(&data).unwrap();
            let method = request["method"].as_str().unwrap_or("");
            let params = &request["params"];
            let result = match method {
                "daemon.health" => {
                    json!({"protocolVersion":miniq_protocol::PROTOCOL_VERSION,"capabilities":{"rejectBusy":true}})
                }
                "session.modelGet" => {
                    json!({"settings":{"model":model,"apiProtocol":"auto"},"effective":{"model":model,"reasoningEffort":"high","apiProtocol":"auto"}})
                }
                "session.modelUpdate" => {
                    if let Some(value) = params["settings"]["model"].as_str() {
                        model = value.into();
                    }
                    json!({})
                }
                "session.approval.get" => json!({"effective":"alwaysAsk"}),
                "session.approval.update" => json!({"effective":params["mode"]}),
                "session.open" => {
                    json!({"session":{"id":"preview","title":if history.is_empty() { "" } else { "Terminal interface preview" },"status":"idle"},"messages":history,"toolCalls":[],"nextCursor":null})
                }
                "session.contextUsage" => json!({"percentUsed":12.0}),
                "model.list" => {
                    json!({"models":["Claude Sonnet","GPT-5.6","DeepSeek V3","Qwen 中文模型"]})
                }
                "model.describe" => json!({"reasoningEfforts":["low","medium","high"]}),
                "workspace.list" => {
                    json!({"workspaces":[{"id":"w","path":std::env::current_dir().unwrap()}]})
                }
                "workspace.open" => json!({"id":"w"}),
                "session.create" => {
                    history.clear();
                    json!({"id":"preview"})
                }
                "session.list" => {
                    json!({"sessions":[{"id":"preview","title":"Terminal interface preview","status":"idle","updatedAt":"2026-11-04T00:00:00Z"}]})
                }
                "session.sendMessage" => {
                    let message = json!({"id":format!("u{}",history.len()),"role":"user","content":params["message"]["content"]});
                    history.push(message.clone());
                    json!({"message":message})
                }
                _ => json!({}),
            };
            socket
                .send(Message::text(
                    json!({"id":request["id"],"result":result}).to_string(),
                ))
                .await
                .unwrap();
            if method == "session.sendMessage" {
                socket.send(Message::text(json!({"type":"message_created","sessionId":"preview","message":history.last()}).to_string())).await.unwrap();
                let answer = "## Interface preview\n\nThe input stays at the bottom while the conversation scrolls.\n\n- **Ctrl+P** opens commands.\n- **Ctrl+X M** switches models.\n- 中文输入和多行粘贴会完整保留。\n\n```rust\nfn main() {\n    println!(\"Hello, miniQ!\");\n}\n```\n";
                for line in answer.split_inclusive('\n') {
                    socket
                        .send(Message::text(
                            json!({"type":"assistant_delta","sessionId":"preview","delta":line})
                                .to_string(),
                        ))
                        .await
                        .unwrap();
                    tokio::time::sleep(Duration::from_millis(60)).await;
                }
                let message =
                    json!({"id":format!("a{}",history.len()),"role":"assistant","content":answer});
                history.push(message.clone());
                socket
                    .send(Message::text(
                        json!({"type":"message_created","sessionId":"preview","message":message})
                            .to_string(),
                    ))
                    .await
                    .unwrap();
                socket
                    .send(Message::text(
                        json!({"type":"turn_completed","sessionId":"preview"}).to_string(),
                    ))
                    .await
                    .unwrap();
            }
        }
    });
    let mut client = Client::connect(directory.path()).await.unwrap();
    client.scope("preview");
    let outcome = run(&mut client, "preview", None, &Default::default()).await;
    server.abort();
    assert_eq!(outcome.unwrap(), 0);
}
