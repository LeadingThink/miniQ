use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Fixture {
    dir: tempfile::TempDir,
    requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new(mode: &'static str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        miniq_local::write_connection_info(
            dir.path(),
            &miniq_local::ConnectionInfo {
                port: listener.local_addr().unwrap().port(),
                token: "private-fixture-token".into(),
                pid: std::process::id(),
            },
        )
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let root = dir.path().to_string_lossy().into_owned();
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    recorded.lock().unwrap().push(request.clone());
                    let method = request["method"].as_str().unwrap();
                    let result = match method {
                        "daemon.health" => {
                            json!({"protocolVersion":1,"capabilities":{"rejectBusy":mode != "old"}})
                        }
                        "settings.get" => {
                            json!({"approvalMode":if mode == "full" {"fullAccess"} else {"alwaysAsk"}})
                        }
                        "workspace.open" => {
                            json!({"id":"workspace-1","path":root,"additionalPaths":["retained-root"]})
                        }
                        "workspace.updateRoots" => request["params"].clone(),
                        "session.create" => json!({"id":"session-1"}),
                        "session.modelGet" => {
                            json!({"settings":{"model":null,"apiProtocol":"auto","reasoningEffort":null}})
                        }
                        "session.modelUpdate" => json!({}),
                        "session.open" => {
                            json!({"session":{"id":"session-1","status":"idle","workingDirectory":root},"lastTurn":{"status":"completed"},
                            "messages":[{"id":"answer-1","role":"assistant","content":"fixture answer"}],"nextCursor":null})
                        }
                        "session.sendMessage" if mode == "busy" => {
                            socket
                                .send(Message::text(
                                    json!({"id":request["id"],"error":{"message":"session busy"}})
                                        .to_string(),
                                ))
                                .await
                                .unwrap();
                            continue;
                        }
                        "session.sendMessage" if mode == "disconnect" => {
                            socket.close(None).await.unwrap();
                            break;
                        }
                        "session.sendMessage" => {
                            // Real daemons can deliver events before the RPC response.
                            socket.send(Message::text(json!({"type":"assistant_delta","sessionId":"other-session","delta":"PRIVATE OTHER TASK"}).to_string())).await.unwrap();
                            socket.send(Message::text(json!({"type":"assistant_delta","sessionId":"session-1","delta":"partial"}).to_string())).await.unwrap();
                            json!({"message":{"id":"user-1"}})
                        }
                        _ => panic!("unexpected method {method}"),
                    };
                    socket
                        .send(Message::text(
                            json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string(),
                        ))
                        .await
                        .unwrap();
                    if method == "session.sendMessage" {
                        if mode == "reconnect" {
                            socket.close(None).await.unwrap();
                            break;
                        }
                        let events = match mode {
                            "question" => vec![
                                json!({"type":"question_requested","question":{"id":"question-1","prompt":"Choose"}}),
                            ],
                            "approval" => vec![
                                json!({"type":"approval_requested","approval":{"id":"approval-1"}}),
                            ],
                            "failure" => vec![
                                json!({"type":"turn_failed","error":"fixture provider failure"}),
                            ],
                            _ => vec![
                                json!({"type":"assistant_replaced","text":""}),
                                json!({"type":"message_created","message":{"id":"answer-1","role":"assistant","content":"fixture answer"}}),
                                json!({"type":"turn_completed"}),
                            ],
                        };
                        for mut event in events {
                            event["sessionId"] = json!("session-1");
                            socket.send(Message::text(event.to_string())).await.unwrap();
                        }
                    }
                }
            }
        });
        Self {
            dir,
            requests,
            server,
        }
    }

    async fn run(&self, args: &[&str], input: &str) -> std::process::Output {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_miniq"));
        command
            .args(["--no-start", "--data-dir"])
            .arg(self.dir.path())
            .arg("-C")
            .arg(self.dir.path())
            .args(args)
            .env_remove("MINIQ_API_KEY")
            .env_remove("MINIQ_DAEMON_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(input.as_bytes()).await.unwrap();
        drop(stdin);
        tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .unwrap()
            .unwrap()
    }
}

#[tokio::test]
async fn stdin_jsonl_is_scoped_and_committed_output_is_authoritative() {
    let fixture = Fixture::new("success").await;
    let result = fixture
        .run(
            &[
                "exec",
                "-",
                "--json",
                "--model",
                "gpt-5.6-sol",
                "--effort",
                "high",
            ],
            "fixture prompt",
        )
        .await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let stdout = String::from_utf8(result.stdout).unwrap();
    assert!(!stdout.contains("PRIVATE OTHER TASK"));
    assert!(!stdout.contains("private-fixture-token"));
    let events: Vec<Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.last().unwrap()["type"], "cli_result");
    assert_eq!(events.last().unwrap()["text"], "fixture answer");
    let requests = fixture.requests.lock().unwrap();
    let send = requests
        .iter()
        .find(|request| request["method"] == "session.sendMessage")
        .unwrap();
    assert_eq!(send["params"]["message"]["content"], "fixture prompt");
    assert_eq!(send["params"]["rejectIfBusy"], true);
    let model = requests
        .iter()
        .find(|request| request["method"] == "session.modelUpdate")
        .unwrap();
    assert_eq!(model["params"]["settings"]["model"], "gpt-5.6-sol");
    assert_eq!(model["params"]["settings"]["reasoningEffort"], "high");
}

#[tokio::test]
async fn plain_stdout_contains_only_final_answer_and_stdin_is_appended() {
    let fixture = Fixture::new("success").await;
    let result = fixture.run(&["exec", "Review"], "piped context").await;
    assert!(result.status.success());
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        "fixture answer\n"
    );
    let requests = fixture.requests.lock().unwrap();
    let send = requests
        .iter()
        .find(|request| request["method"] == "session.sendMessage")
        .unwrap();
    assert_eq!(
        send["params"]["message"]["content"],
        "Review\n\n[stdin]\npiped context"
    );
}

#[tokio::test]
async fn terminal_states_have_meaningful_exit_codes_and_do_not_resend() {
    for (mode, code) in [
        ("failure", 1),
        ("busy", 1),
        ("question", 3),
        ("approval", 3),
        ("disconnect", 1),
        ("reconnect", 0),
    ] {
        let fixture = Fixture::new(mode).await;
        let result = fixture.run(&["exec", "fixture"], "").await;
        assert_eq!(
            result.status.code(),
            Some(code),
            "{mode}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request["method"] == "session.sendMessage")
                .count(),
            1,
            "{mode}"
        );
    }
}

#[tokio::test]
async fn refuses_implicit_full_access_and_old_daemon_without_sending() {
    for mode in ["full", "old"] {
        let fixture = Fixture::new(mode).await;
        let result = fixture.run(&["exec", "fixture"], "").await;
        assert_eq!(result.status.code(), Some(1));
        assert!(!fixture
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request["method"] == "session.sendMessage"));
    }
}

#[tokio::test]
async fn json_mode_reports_preflight_and_admission_errors_as_jsonl() {
    for (mode, kind) in [("full", "cli_error"), ("busy", "cli_result")] {
        let fixture = Fixture::new(mode).await;
        let result = fixture.run(&["exec", "fixture", "--json"], "").await;
        assert_eq!(result.status.code(), Some(1));
        let events: Vec<Value> = String::from_utf8(result.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.last().unwrap()["type"], kind);
        assert_eq!(events.last().unwrap()["exitCode"], 1);
    }
}

#[tokio::test]
async fn output_file_is_created_only_on_success_and_never_overwritten() {
    let fixture = Fixture::new("success").await;
    let path = fixture.dir.path().join("result.txt");
    let result = fixture
        .run(&["exec", "fixture", "-o", path.to_str().unwrap()], "")
        .await;
    assert!(result.status.success());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "fixture answer");
    let result = fixture
        .run(&["exec", "fixture", "-o", path.to_str().unwrap()], "")
        .await;
    assert_eq!(result.status.code(), Some(1));
    assert_eq!(
        fixture
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "session.sendMessage")
            .count(),
        1
    );
}
