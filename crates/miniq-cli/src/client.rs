use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use miniq_local::{read_connection_info, ConnectionInfo};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

#[cfg(test)]
#[path = "client_test_fixture.rs"]
pub(crate) mod test_fixture;

/// Keep structured RPC failures so mutation policies never depend on wording.
#[derive(Debug)]
pub struct RpcCallError {
    pub method: String,
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcCallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}: {} (code {})",
            self.method, self.message, self.code
        )?;
        if let Some(data) = &self.data {
            if !data.is_null() {
                write!(formatter, "; data: {data}")?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for RpcCallError {}

pub fn is_busy(error: &anyhow::Error, method: &str) -> bool {
    error.downcast_ref::<RpcCallError>().is_some_and(|error| {
        error.method == method && error.code == miniq_protocol::ErrorCode::SessionBusy as i64
    })
}

pub struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    events: VecDeque<Value>,
    next_id: u64,
    scope: Option<String>,
    snapshot_cursor: Option<Value>,
    connecting: bool,
    pub directory: PathBuf,
    pub reject_busy: bool,
    /// `--max-turns`: attached to every prompt this client starts.
    pub max_turns: Option<u16>,
}

impl Client {
    pub async fn connect(directory: &Path) -> Result<Self> {
        let info = read_connection_info(directory)?.context("no daemon connection file")?;
        Self::connect_info(directory, info).await
    }

    pub(crate) async fn connect_info(directory: &Path, info: ConnectionInfo) -> Result<Self> {
        miniq_local::DaemonProcess::open(info.pid, &info.process_identity)?
            .context("daemon process has exited or its identity changed")?;
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
            connecting: true,
            directory: directory.into(),
            reject_busy: false,
            max_turns: None,
        };
        let health = client.call("daemon.health", json!({})).await?;
        if health["protocolVersion"] != miniq_protocol::PROTOCOL_VERSION {
            bail!("daemon protocol differs from this CLI; update both before reconnecting");
        }
        client.reject_busy = health["capabilities"]["rejectBusy"] == true;
        client.connecting = false;
        Ok(client)
    }

    pub fn into_bridge_parts(
        self,
    ) -> (WebSocketStream<MaybeTlsStream<TcpStream>>, VecDeque<Value>) {
        (self.socket, self.events)
    }

    pub fn scope(&mut self, session: &str) {
        self.scope = Some(session.to_owned());
        self.snapshot_cursor = None;
        self.events.clear();
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.call_with_timeout(method, params, Duration::from_secs(60))
            .await
    }

    pub async fn call_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        self.call_inner(method, params, timeout, true).await
    }

    /// Observe pause state without consuming any event from the running turn.
    pub async fn inspect_session(&mut self, session: &str) -> Result<Value> {
        self.call_inner(
            "session.open",
            json!({"sessionId":session}),
            Duration::from_secs(60),
            false,
        )
        .await
    }

    async fn call_inner(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        apply_snapshot: bool,
    ) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.socket
            .send(Message::text(
                json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}).to_string(),
            ))
            .await
            .context("daemon request could not be sent; it will not be automatically replayed")?;
        tokio::time::timeout(timeout, async {
            loop {
                let value = self.read().await?;
                if value["id"] == id {
                    if let Some(error) = value.get("error") {
                        return Err(RpcCallError {
                            method: method.to_owned(),
                            code: error["code"].as_i64().unwrap_or(0),
                            message: error["message"].as_str().unwrap_or("RPC error").to_owned(),
                            data: error.get("data").cloned(),
                        }
                        .into());
                    }
                    let result = value["result"].clone();
                    if apply_snapshot && method == "session.open" {
                        self.snapshot_cursor = result.get("eventCursor").cloned();
                        let cursor = self.snapshot_cursor.clone();
                        self.events
                            .retain(|event| after_snapshot(event, cursor.as_ref()));
                    }
                    return Ok(result);
                }
                if self.connecting || self.is_scoped(&value) {
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
                    new.max_turns = self.max_turns;
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
    if no_start {
        return Client::connect(directory)
            .await
            .context("no accessible daemon; --no-start prevents starting one");
    }
    let cancel = tokio_util::sync::CancellationToken::new();
    let startup = miniq_local::lifecycle::ensure(
        directory,
        || {
            daemon_binary(explicit)
                .and_then(|path| Ok(std::process::Command::new(path.canonicalize()?)))
                .map_err(std::io::Error::other)
        },
        miniq_local::lifecycle::START_TIMEOUT,
        &cancel,
    );
    tokio::pin!(startup);
    let info = tokio::select! {
        result = &mut startup => result?,
        _ = tokio::time::sleep(Duration::from_secs(3)) => {
            eprintln!("miniQ: waiting for the local backend to start or finish updating; logs: {}", directory.join("logs").display());
            startup.await?
        }
    };
    Client::connect_info(directory, info).await
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
        .context("miniq-daemon not found; install the terminal pair from https://oss.zaiwen.top/releases/miniq/install.sh (Windows: install.ps1), or set MINIQ_DAEMON_PATH")
}

#[cfg(test)]
mod tests {
    use super::*;
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
