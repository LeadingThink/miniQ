use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[cfg(target_os = "macos")]
#[path = "support/terminal_pty.rs"]
mod pty;

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
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
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
                            json!({"protocolVersion":2,"capabilities":{"rejectBusy":mode != "old"}})
                        }
                        "settings.get" => {
                            json!({"provider":{"baseUrl":"https://oneapi.zaiwenai.com/v1","model":"fixture","hasApiKey": mode != "unconfigured"},"approvalMode":if matches!(mode, "full" | "session-ask") {"fullAccess"} else {"alwaysAsk"}})
                        }
                        "settings.update" => json!({"provider":{"hasApiKey":true}}),
                        "settings.models" | "model.list" => {
                            json!({"models":["claude-opus", "gemini-3.8-flash", "gpt-5.6-sol"]})
                        }
                        "model.describe" => json!({"reasoningEfforts":["low", "medium", "high"]}),
                        "workspace.list" => {
                            json!({"workspaces":[{"id":"workspace-1","path":root}]})
                        }
                        "session.list" => {
                            json!({"sessions":[{"id":"session-1","title":"中文项目测试","status":"idle","updatedAt":"2026-09-25T00:00:00Z"}]})
                        }
                        "session.approval.get" => {
                            json!({"mode":null,"effective":if matches!(mode, "full" | "session-full") {"fullAccess"} else {"alwaysAsk"}})
                        }
                        "workspace.open" => {
                            json!({"id":"workspace-1","path":root,"additionalPaths":["retained-root"]})
                        }
                        "workspace.updateRoots" => request["params"].clone(),
                        "session.create" => json!({"id":"session-1"}),
                        "session.modelGet" => {
                            json!({"settings":{"model":null,"apiProtocol":"auto","reasoningEffort":null},"effective":{"model":"fixture","apiProtocol":"auto","reasoningEffort":null}})
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
                        "session.approval.update" => {
                            json!({"mode":request["params"]["mode"],"effective":request["params"]["mode"]})
                        }
                        "mcp.list" => json!({"servers":[
                            {"name":"github","command":"npx","args":["-y","gh"],"enabled":true,"source":"user","status":"connected"},
                            {"name":"plug","command":"node","args":[],"enabled":true,"source":"plugin","status":"stopped","pluginId":"p1"}]}),
                        "mcp.update" => json!({"ok":true}),
                        "skill.list" => {
                            json!({"skills":[{"name":"review","description":"Code review","version":"1.0","source":"user","enabled":true}]})
                        }
                        "plugin.list" => {
                            json!({"plugins":[{"id":"p1","name":"Plug","version":"0.2","enabled":true,"status":"active","tools":[],"error":null,"description":"Demo"}]})
                        }
                        "session.rename" => {
                            json!({"id":request["params"]["sessionId"],"title":request["params"]["title"]})
                        }
                        "session.history" => json!({"messages":[
                            {"id":"answer-0","role":"assistant","content":"a"},
                            {"id":"user-2","role":"user","content":"q"},
                            {"id":"answer-1","role":"assistant","content":"b"}],"toolCalls":[],"nextCursor":null}),
                        "session.fork" => json!({"id":"session-2","title":"fork"}),
                        "session.contextUsage" => {
                            json!({"estimatedTokens":1200,"contextWindowTokens":200000,
                            "autoCompactTokens":160000,"percentUsed":0.6,"lastRequestTokens":1100})
                        }
                        "session.compact" => {
                            json!({"compacted":true,"estimatedTokensBefore":1200,"estimatedTokensAfter":300})
                        }
                        "session.undo" => {
                            json!({"removedMessage":{"id":"user-1","role":"user","content":"hello"},
                            "removedMessageIds":["user-1","answer-1"],"restoredFiles":[{"path":"a.txt"}],"failedFiles":[]})
                        }
                        "session.diff" => {
                            json!({"files":[{"path":"a.txt","oldExists":true,"newExists":true,"binary":false,
                            "additions":1,"deletions":1,"hunks":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,
                            "lines":[{"kind":"deletion","content":"old"},{"kind":"addition","content":"new"}]}]}],
                            "additions":1,"deletions":1})
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
                            "schema" => vec![
                                json!({"type":"assistant_replaced","text":""}),
                                json!({"type":"message_created","message":{"id":"answer-1","role":"assistant","content":"```json\n{\"ok\":true}\n```"}}),
                                json!({"type":"turn_completed"}),
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
    assert_eq!(model["params"]["sessionId"], "session-1");
    assert!(!requests.iter().any(|request| matches!(
        request["method"].as_str(),
        Some("settings.update" | "workspace.modelUpdate" | "model.globalUpdate")
    )));
}

#[tokio::test]
async fn noninteractive_missing_key_does_not_create_or_send_a_task() {
    let fixture = Fixture::new("unconfigured").await;
    let result = fixture.run(&["exec", "fixture", "--json"], "").await;
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("miniq configure"));
    assert!(fixture
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| matches!(
            request["method"].as_str(),
            Some("daemon.health" | "settings.get")
        )));
}

#[tokio::test]
async fn interactive_commands_reject_piped_input_before_connecting() {
    for args in [vec![], vec!["resume"], vec!["resume", "--last"]] {
        let fixture = Fixture::new("success").await;
        let result = fixture.run(&args, "unexpected piped input").await;
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("miniq exec -"));
        assert!(fixture.requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn piped_sessions_stay_json_for_scripts() {
    let fixture = Fixture::new("success").await;
    let result = fixture.run(&["sessions", "--all"], "").await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let value: Value =
        serde_json::from_slice(&result.stdout).expect("piped sessions output is JSON");
    assert_eq!(value["sessions"][0]["id"], "session-1");
    assert_eq!(value["sessions"][0]["title"], "中文项目测试");
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
    for mode in ["full", "session-full", "old"] {
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
async fn resumed_session_approval_override_is_authoritative() {
    for (mode, allowed) in [("session-full", false), ("session-ask", true)] {
        let fixture = Fixture::new(mode).await;
        let result = fixture
            .run(&["exec", "--session", "session-1", "fixture"], "")
            .await;
        assert_eq!(
            result.status.success(),
            allowed,
            "{mode}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .any(|request| request["method"] == "session.sendMessage"),
            allowed
        );
        assert!(!requests
            .iter()
            .any(|request| request["method"] == "settings.update"
                || request["method"] == "session.approval.update"));
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

fn methods(fixture: &Fixture) -> Vec<Value> {
    fixture.requests.lock().unwrap().clone()
}

#[tokio::test]
async fn explicit_approval_replaces_the_always_ask_requirement() {
    let fixture = Fixture::new("full").await;
    let result = fixture
        .run(&["exec", "task", "--approval", "auto"], "")
        .await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let requests = methods(&fixture);
    let update = requests
        .iter()
        .find(|request| request["method"] == "session.approval.update")
        .expect("approval update");
    assert_eq!(
        update["params"],
        json!({"sessionId":"session-1","mode":"auto"})
    );
    assert!(!requests
        .iter()
        .any(|request| request["method"] == "session.approval.get"));

    let fixture = Fixture::new("approval").await;
    let result = fixture
        .run(&["-p", "task", "--dangerously-bypass-approvals"], "")
        .await;
    assert_eq!(result.status.code(), Some(3));
    assert!(methods(&fixture)
        .iter()
        .any(|request| request["method"] == "session.approval.update"
            && request["params"]["mode"] == "fullAccess"));
}

#[tokio::test]
async fn output_schema_validates_the_final_answer() {
    let fixture = Fixture::new("schema").await;
    let good = r#"{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}"#;
    let result = fixture
        .run(
            &[
                "exec",
                "task",
                "--output-schema",
                good,
                "--output-format",
                "json",
            ],
            "",
        )
        .await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["type"], "result");
    assert_eq!(value["structuredOutput"], json!({"ok":true}));
    let send = methods(&fixture)
        .into_iter()
        .find(|request| request["method"] == "session.sendMessage")
        .unwrap();
    assert!(send["params"].to_string().contains("JSON Schema"));

    let bad = r#"{"type":"object","properties":{"ok":{"type":"string"}}}"#;
    let result = fixture
        .run(&["--print", "task", "--json-schema", bad], "")
        .await;
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr).contains("$.ok: expected string"));

    let fixture = Fixture::new("").await;
    let result = fixture
        .run(&["exec", "task", "--output-schema", good], "")
        .await;
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr).contains("not valid JSON"));
}

#[tokio::test]
async fn output_format_json_and_stream_json() {
    let fixture = Fixture::new("").await;
    let result = fixture
        .run(&["exec", "task", "--output-format", "json"], "")
        .await;
    assert!(result.status.success());
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["text"], "fixture answer");
    assert_eq!(value["exitCode"], 0);
    let result = fixture
        .run(&["exec", "task", "--output-format", "stream-json"], "")
        .await;
    let stdout = String::from_utf8(result.stdout).unwrap();
    let last: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(last["type"], "cli_result");
    let fixture = Fixture::new("full").await;
    let result = fixture
        .run(&["exec", "task", "--output-format", "json"], "")
        .await;
    assert_eq!(result.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["type"], "cli_error");
}

#[tokio::test]
async fn exec_resume_continues_the_latest_session() {
    for args in [
        vec!["exec", "--resume-last", "more"],
        vec!["exec", "resume", "--last", "more"],
        vec!["exec", "resume", "session-1", "more"],
    ] {
        let fixture = Fixture::new("").await;
        let result = fixture.run(&args, "").await;
        assert!(
            result.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let requests = methods(&fixture);
        assert!(
            requests
                .iter()
                .any(|request| request["method"] == "session.open"),
            "{args:?}"
        );
        assert!(
            !requests
                .iter()
                .any(|request| request["method"] == "session.create"),
            "{args:?}"
        );
    }
}

#[tokio::test]
async fn management_subcommands_print_tables_and_json() {
    let fixture = Fixture::new("").await;
    let result = fixture.run(&["mcp", "list"], "").await;
    let stdout = String::from_utf8(result.stdout).unwrap();
    assert!(stdout.starts_with("NAME"), "{stdout}");
    assert!(stdout.contains("github") && stdout.contains("npx -y gh"));
    let result = fixture.run(&["mcp", "get", "github", "--json"], "").await;
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["command"], "npx");
    assert_eq!(
        fixture
            .run(&["mcp", "get", "missing"], "")
            .await
            .status
            .code(),
        Some(1)
    );

    let result = fixture
        .run(
            &["mcp", "add", "--env", "A=1", "fs", "node", "server.js"],
            "",
        )
        .await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result = fixture.run(&["mcp", "remove", "github"], "").await;
    assert!(result.status.success());
    let updates: Vec<Value> = methods(&fixture)
        .into_iter()
        .filter(|request| request["method"] == "mcp.update")
        .map(|request| request["params"]["servers"].clone())
        .collect();
    assert_eq!(updates[0].as_array().unwrap().len(), 2);
    assert_eq!(updates[0][1]["env"], json!({"A":"1"}));
    assert_eq!(updates[1], json!([]));
    assert_eq!(
        fixture
            .run(&["mcp", "remove", "plug"], "")
            .await
            .status
            .code(),
        Some(1)
    );

    let stdout = String::from_utf8(fixture.run(&["skills", "list"], "").await.stdout).unwrap();
    assert!(stdout.contains("review") && stdout.contains("Code review"));
    let result = fixture.run(&["plugins", "list", "--json"], "").await;
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["plugins"][0]["id"], "p1");

    let stdout = String::from_utf8(fixture.run(&["config", "get"], "").await.stdout).unwrap();
    assert!(stdout.contains("provider.model = fixture"), "{stdout}");
    let stdout = String::from_utf8(
        fixture
            .run(&["config", "get", "provider.model"], "")
            .await
            .stdout,
    )
    .unwrap();
    assert_eq!(stdout, "fixture\n");
    let result = fixture
        .run(&["config", "set", "provider.model", "other"], "")
        .await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let update = methods(&fixture)
        .into_iter()
        .find(|request| request["method"] == "settings.update")
        .unwrap();
    assert_eq!(update["params"]["provider"]["model"], "other");
    assert_eq!(
        update["params"]["provider"]["baseUrl"],
        "https://oneapi.zaiwenai.com/v1"
    );
}

#[tokio::test]
async fn session_subcommands_diff_fork_and_rename() {
    let fixture = Fixture::new("").await;
    let result = fixture.run(&["diff", "session-1"], "").await;
    let stdout = String::from_utf8(result.stdout).unwrap();
    assert!(
        stdout.contains("--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new"),
        "{stdout}"
    );
    assert!(!stdout.contains('\x1b'));
    let result = fixture.run(&["diff", "--json"], "").await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let result = fixture.run(&["fork", "session-1"], "").await;
    assert!(String::from_utf8(result.stdout)
        .unwrap()
        .contains("session-2"));
    let result = fixture
        .run(&["fork", "session-1", "--at", "answer-0", "--json"], "")
        .await;
    assert!(result.status.success());
    let forks: Vec<Value> = methods(&fixture)
        .into_iter()
        .filter(|request| request["method"] == "session.fork")
        .map(|request| request["params"]["anchorMessageId"].clone())
        .collect();
    assert_eq!(forks, vec![json!("answer-1"), json!("answer-0")]);

    let result = fixture.run(&["rename", "session-1", "新标题"], "").await;
    assert!(String::from_utf8(result.stdout).unwrap().contains("新标题"));
}

#[tokio::test]
async fn doctor_json_keeps_the_report() {
    let fixture = Fixture::new("").await;
    let result = fixture.run(&["doctor", "--json"], "").await;
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(value["daemon"].is_object());
    assert!(value["terminalDependencies"].is_object());
}
