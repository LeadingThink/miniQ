//! A stalled SSH request must not block other hosts, local RPCs, or another view.

use super::*;
use crate::{server, state::AppState, UnconfiguredProvider};
use futures_util::{SinkExt, StreamExt};
use miniq_memory::Store;
use std::path::Path;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

struct Client {
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    inbox: Vec<Value>,
}

impl Client {
    async fn connect(port: u16) -> Self {
        let (socket, _) = connect_async(format!("ws://127.0.0.1:{port}/ws?token=ssh-test"))
            .await
            .unwrap();
        let mut client = Self {
            socket,
            inbox: Vec::new(),
        };
        // Also ensures this socket's event subscription is attached before fixtures emit.
        client.call("ready", "daemon.health", Value::Null).await;
        client
    }

    async fn send(&mut self, id: &str, method: &str, params: Value) {
        let request = json!({"jsonrpc":"2.0", "id": id, "method": method, "params": params});
        self.socket
            .send(Message::Text(request.to_string().into()))
            .await
            .unwrap();
    }

    async fn matching(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(index) = self.inbox.iter().position(&wanted) {
                    return self.inbox.remove(index);
                }
                let message = self.socket.next().await.unwrap().unwrap();
                if let Message::Text(text) = message {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if wanted(&value) {
                        return value;
                    }
                    self.inbox.push(value);
                }
            }
        })
        .await
        .expect("local socket stalled behind an SSH request")
    }

    async fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(id, method, params).await;
        let response = self.matching(|value| value["id"] == id).await;
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }

    async fn event(&mut self, host: &str) -> Value {
        self.matching(|value| value["type"] == "host_event" && value["hostId"] == host)
            .await
    }
}

fn command(script: &str, log: &Path) -> tokio::process::Command {
    let ready = format!("printf '%s\\n' '{{\"type\":\"miniq_bridge_ready\",\"protocolVersion\":{},\"version\":\"test\"}}'; ", miniq_protocol::PROTOCOL_VERSION);
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(ready + script)
        .arg("ssh-fixture")
        .arg(log);
    command
}

async fn start_hosts(state: &AppState, log: &Path) {
    for host in ["slow", "fast"] {
        state
            .ssh_hosts
            .dispatch("host.save", Some(json!({"hostId":host})))
            .await
            .unwrap();
    }
    let slow = command(
        r#"
        IFS= read -r first
        printf '%s\n' "$first" >> "$1"
        printf '%s\n' '{"type":"assistant_delta","sessionId":"same-session","delta":"slow accepted"}'
        IFS= read -r release
        printf '%s\n' "$release" >> "$1"
        printf '%s\n' "$first" "$release" | sed 's/"method":/"result":/'
        while IFS= read -r line; do
            printf '%s\n' "$line" >> "$1"
            printf '%s\n' "$line" | sed 's/"method":/"result":/'
        done
    "#,
        log,
    );
    let fast = command(
        r#"
        while IFS= read -r line; do
            printf '%s\n' '{"type":"assistant_delta","sessionId":"same-session","delta":"fast event"}'
            printf '%s\n' "$line" | sed 's/"method":/"result":/'
        done
    "#,
        log,
    );
    state.ssh_hosts.connect_with("slow", slow).await.unwrap();
    state.ssh_hosts.connect_with("fast", fast).await.unwrap();
}

fn host_call(host: &str, method: &str) -> Value {
    json!({"hostId":host, "method":method, "params":{"sessionId":"same-session"}})
}

#[tokio::test]
async fn views_share_hosts_without_head_of_line_blocking_cancel_or_replay() {
    let directory = tempfile::tempdir().unwrap();
    let log = directory.path().join("slow-requests.jsonl");
    let mut state = AppState::new(
        Store::open_in_memory().unwrap(),
        "ssh-test".into(),
        Arc::new(UnconfiguredProvider),
    );
    state.ssh_hosts = Arc::new(SshHostManager::new(
        directory.path(),
        state.shutdown.clone(),
    ));
    start_hosts(&state, &log).await;
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serving = state.clone();
    let server = tokio::spawn(async move {
        server::serve(listener, serving).await.unwrap();
    });
    let mut first = Client::connect(port).await;
    let mut second = Client::connect(port).await;

    first
        .send(
            "same-id",
            "host.call",
            host_call("slow", "session.sendMessage"),
        )
        .await;
    for client in [&mut first, &mut second] {
        let event = client.event("slow").await;
        assert_eq!(event["event"]["delta"], "slow accepted");
        assert_eq!(event["event"]["sessionId"], "same-session");
    }
    // The slow fixture has accepted a request but cannot answer until explicitly released.
    let (local, remote) = tokio::join!(
        first.call("local", "daemon.health", Value::Null),
        second.call("same-id", "host.call", host_call("fast", "workspace.list")),
    );
    assert_eq!(local["protocolVersion"], miniq_protocol::PROTOCOL_VERSION);
    assert_eq!(remote, "workspace.list");
    for client in [&mut first, &mut second] {
        let event = client.event("fast").await;
        assert_eq!(event["event"]["delta"], "fast event");
        assert_eq!(event["event"]["sessionId"], "same-session");
    }
    assert!(!first.inbox.iter().any(|value| value["id"] == "same-id"));
    first.socket.close(None).await.unwrap();
    drop(first);
    assert_eq!(
        state.ssh_hosts.hosts.get("slow").unwrap().snapshot("slow")["state"],
        "connected"
    );
    assert_eq!(
        second
            .call("release", "host.call", host_call("slow", "session.open"))
            .await,
        "session.open"
    );
    let requests: Vec<Value> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["method"], "session.sendMessage");
    assert_eq!(requests[1]["method"], "session.open");
    assert_ne!(requests[0]["id"], requests[1]["id"]);

    let mut reopened = Client::connect(port).await;
    assert_eq!(
        reopened
            .call("same-id", "host.call", host_call("fast", "new.request"))
            .await,
        "new.request"
    );
    reopened
        .call("disconnect", "host.disconnect", json!({"hostId":"slow"}))
        .await;
    assert_eq!(
        second
            .call(
                "still-alive",
                "host.call",
                host_call("fast", "daemon.health")
            )
            .await,
        "daemon.health"
    );
    // No automatic cancel, duplicate submission, or request replay was written to the slow host.
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 2);
    state.shutdown.cancel();
    drop(second);
    drop(reopened);
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
