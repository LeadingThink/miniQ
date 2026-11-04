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
    let (events, _) = tokio::sync::broadcast::channel::<Value>(256);
    let state = std::sync::Arc::new(std::sync::Mutex::new(State {
        model: "Claude Sonnet".into(),
        history: vec![],
    }));
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let state = state.clone();
            let events = events.clone();
            connections.spawn(async move {
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let mut receiver = events.subscribe();
                loop {
                    tokio::select! {
                        event = receiver.recv() => {
                            let Ok(event) = event else { break; };
                            if socket.send(Message::text(event.to_string())).await.is_err() { break; }
                        }
                        request = socket.next() => {
                            let Some(Ok(Message::Text(data))) = request else { break; };
                            let request: Value = serde_json::from_str(&data).unwrap();
                            let result = reply(&state, &request);
                            if socket.send(Message::text(json!({"id":request["id"],"result":result}).to_string())).await.is_err() { break; }
                            if request["method"] == "session.sendMessage" {
                                let state = state.clone();
                                let events = events.clone();
                                tokio::spawn(respond(state, events));
                            }
                        }
                    }
                }
            });
        }
    });
    let mut client = Client::connect(directory.path()).await.unwrap();
    client.scope("preview");
    let outcome = run(&mut client, "preview", None, &Default::default()).await;
    server.abort();
    assert_eq!(outcome.unwrap(), 0);
}

struct State {
    model: String,
    history: Vec<Value>,
}

fn reply(state: &std::sync::Mutex<State>, request: &Value) -> Value {
    let mut state = state.lock().unwrap();
    let method = request["method"].as_str().unwrap_or("");
    let params = &request["params"];
    let result = match method {
        "daemon.health" => {
            json!({"protocolVersion":miniq_protocol::PROTOCOL_VERSION,"capabilities":{"rejectBusy":true}})
        }
        "session.modelGet" => {
            json!({"settings":{"model":state.model,"apiProtocol":"auto"},"effective":{"model":state.model,"reasoningEffort":"high","apiProtocol":"auto"}})
        }
        "session.modelUpdate" => {
            if let Some(value) = params["settings"]["model"].as_str() {
                state.model = value.into();
            }
            json!({})
        }
        "session.approval.get" => json!({"effective":"alwaysAsk"}),
        "session.approval.update" => json!({"effective":params["mode"]}),
        "session.open" => {
            json!({"session":{"id":"preview","title":if state.history.is_empty() { "" } else { "Terminal interface preview" },"status":"idle"},"messages":state.history,"toolCalls":[],"nextCursor":null})
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
            state.history.clear();
            json!({"id":"preview"})
        }
        "session.list" => {
            json!({"sessions":[{"id":"preview","title":"Terminal interface preview","status":"idle","updatedAt":"2026-11-04T00:00:00Z"}]})
        }
        "session.sendMessage" => {
            let message = json!({"id":format!("u{}",state.history.len()),"role":"user","content":params["message"]["content"]});
            state.history.push(message.clone());
            json!({"message":message})
        }
        _ => json!({}),
    };
    result
}

async fn respond(
    state: std::sync::Arc<std::sync::Mutex<State>>,
    events: tokio::sync::broadcast::Sender<Value>,
) {
    let user = state.lock().unwrap().history.last().cloned();
    let _ = events.send(json!({"type":"message_created","sessionId":"preview","message":user}));
    let answer = "## Interface preview\n\nInput stays editable while requests run.\n\n- **Ctrl+P** opens commands.\n- **Ctrl+X M** switches models.\n- 中文和多行粘贴会完整保留。\n";
    for line in answer.split_inclusive('\n') {
        let _ = events.send(json!({"type":"assistant_delta","sessionId":"preview","delta":line}));
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    let message = {
        let mut state = state.lock().unwrap();
        let message =
            json!({"id":format!("a{}",state.history.len()),"role":"assistant","content":answer});
        state.history.push(message.clone());
        message
    };
    let _ = events.send(json!({"type":"message_created","sessionId":"preview","message":message}));
    let _ = events.send(json!({"type":"turn_completed","sessionId":"preview"}));
}
