use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio_tungstenite::tungstenite::{handshake::server::Request, Message};

struct Fixture {
    directory: tempfile::TempDir,
    requests: Arc<Mutex<Vec<Value>>>,
    pongs: Arc<Mutex<usize>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new(protocol: u32, disconnect: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        miniq_local::write_connection_info(
            directory.path(),
            &miniq_local::ConnectionInfo {
                port: listener.local_addr().unwrap().port(),
                token: "private-bridge-fixture-token".into(),
                pid: std::process::id(),
            },
        )
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let pongs = Arc::new(Mutex::new(0));
        let recorded = requests.clone();
        let received_pongs = pongs.clone();
        let server = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let recorded = recorded.clone();
                let pongs = received_pongs.clone();
                tokio::spawn(async move {
                    let mut socket = tokio_tungstenite::accept_hdr_async(
                        stream,
                        |request: &Request, response| {
                            assert_eq!(
                                request.uri().query(),
                                Some("token=private-bridge-fixture-token")
                            );
                            Ok(response)
                        },
                    )
                    .await
                    .unwrap();
                    while let Some(Ok(message)) = socket.next().await {
                        let text = match message {
                            Message::Text(text) => text,
                            Message::Pong(_) => {
                                *pongs.lock().unwrap() += 1;
                                continue;
                            }
                            Message::Close(_) => break,
                            _ => continue,
                        };
                        let request: Value = serde_json::from_str(&text).unwrap();
                        recorded.lock().unwrap().push(request.clone());
                        let health = request["method"] == "daemon.health";
                        let event = if health {
                            "before_ready"
                        } else {
                            "before_response"
                        };
                        socket
                            .send(Message::text(json!({"type":event}).to_string()))
                            .await
                            .unwrap();
                        let result = if health {
                            json!({"protocolVersion":protocol})
                        } else {
                            request["params"].clone()
                        };
                        socket
                            .send(Message::text(
                                json!({"jsonrpc":"2.0","id":request["id"],"result":result})
                                    .to_string(),
                            ))
                            .await
                            .unwrap();
                        if !health {
                            socket
                                .send(Message::text("{\n\"type\":\"after_response\"\n}"))
                                .await
                                .unwrap();
                            if disconnect {
                                socket.close(None).await.unwrap();
                                break;
                            }
                        }
                        socket
                            .send(Message::Ping(vec![1, 2, 3].into()))
                            .await
                            .unwrap();
                    }
                });
            }
        });
        Self {
            directory,
            requests,
            pongs,
            server,
        }
    }

    fn bridge(&self) -> Child {
        Command::new(env!("CARGO_BIN_EXE_miniq"))
            .args(["bridge", "--no-start", "--data-dir"])
            .arg(self.directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }
}

async fn read_json(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn authenticated_bridge_preserves_event_order_and_eof_only_detaches() {
    let fixture = Fixture::new(miniq_protocol::PROTOCOL_VERSION, false).await;
    let mut child = fixture.bridge();
    let mut input = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    assert_eq!(
        read_json(&mut lines).await,
        json!({"type":"miniq_bridge_ready",
        "protocolVersion":miniq_protocol::PROTOCOL_VERSION,"version":env!("CARGO_PKG_VERSION")})
    );
    assert_eq!(read_json(&mut lines).await["type"], "before_ready");
    // ID 1 was used by internal health. It is consumed and can be reused safely.
    let request = json!({"jsonrpc":"2.0","id":1,"method":"session.sendMessage",
        "params":{"content":"中文\nline two","nested":{"items":[1,2,3]}}});
    input
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    assert_eq!(read_json(&mut lines).await["type"], "before_response");
    let response = read_json(&mut lines).await;
    assert_eq!(response["id"], 1);
    assert_eq!(response["result"], request["params"]);
    assert_eq!(read_json(&mut lines).await["type"], "after_response");
    drop(input);
    let result = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(result.stderr.is_empty());
    {
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1], request);
    }
    assert!(*fixture.pongs.lock().unwrap() >= 1);

    // The shared server remains alive and usable after stdio closes.
    let mut observer = fixture.bridge();
    let mut observer_lines = BufReader::new(observer.stdout.take().unwrap()).lines();
    assert_eq!(
        read_json(&mut observer_lines).await["type"],
        "miniq_bridge_ready"
    );
    drop(observer.stdin.take());
    assert!(
        tokio::time::timeout(Duration::from_secs(5), observer.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn malformed_or_incomplete_input_is_not_forwarded_and_diagnostics_are_stderr() {
    for input_text in [
        "{broken}\n",
        "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"x\"}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"x\"}",
    ] {
        let fixture = Fixture::new(miniq_protocol::PROTOCOL_VERSION, false).await;
        let mut child = fixture.bridge();
        let mut input = child.stdin.take().unwrap();
        input.write_all(input_text.as_bytes()).await.unwrap();
        drop(input);
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(!output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(stdout.lines().count(), 2);
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
        assert!(stderr.contains("bridge"));
        assert!(!stdout.contains("private-bridge-fixture-token"));
        assert!(!stderr.contains("private-bridge-fixture-token"));
    }
}

#[tokio::test]
async fn daemon_disconnect_exits_with_stdin_still_open_and_never_replays() {
    let fixture = Fixture::new(miniq_protocol::PROTOCOL_VERSION, true).await;
    let mut child = fixture.bridge();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"session.sendMessage\",\"params\":{}}\n",
        )
        .await
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("no requests were replayed"));
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
    drop(input);
}

#[tokio::test]
async fn incompatible_daemon_never_announces_readiness() {
    let fixture = Fixture::new(miniq_protocol::PROTOCOL_VERSION + 1, false).await;
    let mut child = fixture.bridge();
    drop(child.stdin.take());
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private-bridge-fixture-token"));
}
