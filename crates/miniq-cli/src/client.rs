use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use miniq_local::{read_connection_info, ConnectionInfo};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

pub struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    events: VecDeque<Value>,
    next_id: u64,
    scope: Option<String>,
    snapshot_cursor: Option<Value>,
    pub directory: PathBuf,
    pub reject_busy: bool,
}

impl Client {
    pub async fn connect(directory: &Path) -> Result<Self> {
        let info = read_connection_info(directory).context("no daemon connection file")?;
        Self::connect_info(directory, info).await
    }

    async fn connect_info(directory: &Path, info: ConnectionInfo) -> Result<Self> {
        let mut url = url::Url::parse(&format!("ws://127.0.0.1:{}/ws", info.port))?;
        url.query_pairs_mut().append_pair("token", &info.token);
        // Never propagate a transport error containing the authenticated URL.
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(5),
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await
        .context("daemon connection timed out")?
        .map_err(|_| anyhow::anyhow!("daemon unavailable or authentication rejected"))?;
        let mut client = Self {
            socket,
            events: VecDeque::new(),
            next_id: 0,
            scope: None,
            snapshot_cursor: None,
            directory: directory.into(),
            reject_busy: false,
        };
        let health = client.call("daemon.health", json!({})).await?;
        if health["protocolVersion"] != miniq_protocol::PROTOCOL_VERSION {
            bail!("daemon protocol differs from this CLI; update both before reconnecting");
        }
        client.reject_busy = health["capabilities"]["rejectBusy"] == true;
        Ok(client)
    }

    pub fn scope(&mut self, session: &str) {
        self.scope = Some(session.to_owned());
        self.snapshot_cursor = None;
        self.events.clear();
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.socket
            .send(Message::text(
                json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}).to_string(),
            ))
            .await
            .context("daemon request could not be sent; it will not be automatically replayed")?;
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let value = self.read().await?;
                if value["id"] == id {
                    if let Some(error) = value.get("error") {
                        bail!(
                            "{}: {}",
                            method,
                            error["message"].as_str().unwrap_or("RPC error")
                        );
                    }
                    let result = value["result"].clone();
                    if method == "session.open" {
                        self.snapshot_cursor = result.get("eventCursor").cloned();
                        let cursor = self.snapshot_cursor.clone();
                        self.events
                            .retain(|event| after_snapshot(event, cursor.as_ref()));
                    }
                    return Ok(result);
                }
                if self.is_scoped(&value) {
                    self.events.push_back(value);
                }
            }
        })
        .await
        .context("RPC timed out; outcome unknown, inspect the session before retrying")?
    }

    fn is_scoped(&self, value: &Value) -> bool {
        value["type"] == "remote_resync"
            || self
                .scope
                .as_deref()
                .is_some_and(|id| value["sessionId"].as_str() == Some(id))
    }

    async fn read(&mut self) -> Result<Value> {
        loop {
            match self.socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    return serde_json::from_str(&text).context("invalid daemon JSON")
                }
                Some(Ok(Message::Ping(data))) => self.socket.send(Message::Pong(data)).await?,
                Some(Ok(Message::Close(_))) | None => {
                    bail!("daemon disconnected; the task may still be running")
                }
                Some(Err(_)) => {
                    bail!("daemon transport interrupted; the task may still be running")
                }
                _ => {}
            }
        }
    }

    pub async fn next_event(&mut self) -> Result<Value> {
        if let Some(value) = self.events.pop_front() {
            return Ok(value);
        }
        loop {
            let value = match tokio::time::timeout(Duration::from_secs(30), self.read()).await {
                Ok(value) => value?,
                Err(_) => {
                    self.call("daemon.health", json!({})).await?;
                    if let Some(value) = self.events.pop_front() {
                        return Ok(value);
                    }
                    continue;
                }
            };
            if self.is_scoped(&value) && after_snapshot(&value, self.snapshot_cursor.as_ref()) {
                return Ok(value);
            }
        }
    }

    pub async fn reconnect(&mut self, session: &str) -> Result<Value> {
        for _ in 0..5 {
            match Self::connect(&self.directory).await {
                Ok(mut new) => {
                    new.scope(session);
                    let snapshot = new
                        .call("session.open", json!({"sessionId":session}))
                        .await?;
                    *self = new;
                    return Ok(snapshot);
                }
                Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
            }
        }
        bail!("could not reconnect; use `miniq watch {session}`. No prompt was resent")
    }
}

fn after_snapshot(event: &Value, cursor: Option<&Value>) -> bool {
    let Some(cursor) = cursor else {
        return true;
    };
    let event_cursor = &event["eventCursor"];
    event_cursor["epoch"] != cursor["epoch"]
        || event_cursor["sequence"]
            .as_u64()
            .zip(cursor["sequence"].as_u64())
            .is_none_or(|(event, snapshot)| event > snapshot)
}

pub async fn ensure(directory: &Path, explicit: Option<&Path>, no_start: bool) -> Result<Client> {
    if let Ok(client) = Client::connect(directory).await {
        return Ok(client);
    }
    if no_start {
        bail!("no accessible daemon; --no-start prevents starting one");
    }
    // Do not spawn around a live but incompatible/unauthenticated daemon.
    if let Some(info) = read_connection_info(directory) {
        if miniq_local::health_ok(info.port) {
            return Client::connect(directory).await;
        }
    }
    let binary = daemon_binary(explicit)?;
    let mut command = std::process::Command::new(&binary);
    command
        .env("MINIQ_DATA_DIR", directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach_terminal(&mut command);
    let mut child = command
        .spawn()
        .with_context(|| format!("start {}", binary.display()))?;
    // Reap without tying the daemon lifetime to this terminal.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    for _ in 0..80 {
        if let Ok(client) = Client::connect(directory).await {
            return Ok(client);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    bail!(
        "daemon did not become ready; inspect {}/logs",
        directory.display()
    )
}

fn detach_terminal(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Ctrl+C in one terminal must not signal the shared daemon or its tasks.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0000_0200);
    }
}

fn daemon_binary(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return path
            .canonicalize()
            .context("MINIQ_DAEMON_PATH is not a readable executable path");
    }
    let name = if cfg!(windows) {
        "miniq-daemon.exe"
    } else {
        "miniq-daemon"
    };
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(name));
        }
    }
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from(
        "/Applications/miniQ.app/Contents/MacOS/miniq-daemon",
    ));
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|path| path.join(name)));
    }
    candidates.into_iter().find(|path| path.is_file())
        .context("miniq-daemon not found; run scripts/install-cli.sh (or install-cli.ps1) from the source checkout, or set MINIQ_DAEMON_PATH")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn spawned_daemon_has_its_own_process_group() {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "ps -o pid= -o pgid= -p $$"]);
        detach_terminal(&mut command);
        let output = command.output().unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        let ids: Vec<_> = text.split_whitespace().collect();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ids[1]);
    }

    #[test]
    fn snapshot_cursor_deduplicates_pending_approvals_without_losing_new_events() {
        let cursor = json!({"epoch":"one", "sequence":5});
        assert!(!after_snapshot(
            &json!({"eventCursor":{"epoch":"one","sequence":5}}),
            Some(&cursor)
        ));
        assert!(after_snapshot(
            &json!({"eventCursor":{"epoch":"one","sequence":6}}),
            Some(&cursor)
        ));
        assert!(after_snapshot(
            &json!({"eventCursor":{"epoch":"two","sequence":1}}),
            Some(&cursor)
        ));
    }
}
