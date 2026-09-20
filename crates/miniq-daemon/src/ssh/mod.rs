//! Daemon-owned SSH connections shared by independent desktop and relay clients.

mod config;
#[cfg(all(test, unix))]
mod local_socket_tests;
mod process;
#[cfg(test)]
mod smoke;
mod store;
#[cfg(test)]
mod tests;
mod transport;

use std::path::Path;
use std::sync::Arc;

use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use store::{Entry, HostStore};

pub struct SshHostManager {
    hosts: HostStore,
    events: broadcast::Sender<Value>,
    shutdown: CancellationToken,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostInput {
    host_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CallInput {
    host_id: String,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

impl SshHostManager {
    pub fn new(data_dir: &Path, shutdown: CancellationToken) -> Self {
        Self {
            hosts: HostStore::load(data_dir.join("ssh-hosts.json")),
            events: broadcast::channel(1024).0,
            shutdown,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn dispatch(
        self: &Arc<Self>,
        method: &str,
        raw: Option<Value>,
    ) -> Result<Value, RpcError> {
        if method == "host.list" {
            let hosts = self.hosts.list()?;
            return Ok(match config::hosts() {
                Ok(discovered) => json!({"hosts": hosts, "discovered": discovered}),
                Err(error) => json!({"hosts": hosts, "discovered": [], "discoveryError": error}),
            });
        }
        if method == "host.call" {
            let input: CallInput = parse(raw)?;
            return self.call(&input.host_id, &input.method, input.params).await;
        }
        let input: HostInput = parse(raw)?;
        config::validate_host(&input.host_id).map_err(invalid)?;
        match method {
            "host.save" => {
                let entry = self.hosts.save(&input.host_id)?;
                changed(&self.events, &input.host_id);
                Ok(entry.snapshot(&input.host_id))
            }
            "host.remove" => {
                if let Some(entry) = self.hosts.remove(&input.host_id)? {
                    entry.disconnect(true);
                    changed(&self.events, &input.host_id);
                }
                Ok(json!({"removed": true}))
            }
            "host.connect" => self.connect(&input.host_id).await,
            "host.disconnect" => {
                let entry = self.hosts.get(&input.host_id)?;
                entry.disconnect(false);
                changed(&self.events, &input.host_id);
                Ok(entry.snapshot(&input.host_id))
            }
            _ => Err(RpcError::new(
                ErrorCode::MethodNotFound,
                "未知 SSH 主机操作",
            )),
        }
    }

    pub async fn connect(self: &Arc<Self>, host: &str) -> Result<Value, RpcError> {
        config::validate_host(host).map_err(invalid)?;
        self.connect_with(host, process::ssh_command(host)).await
    }

    async fn connect_with(
        self: &Arc<Self>,
        host: &str,
        command: tokio::process::Command,
    ) -> Result<Value, RpcError> {
        let entry = self.hosts.get(host)?;
        let requested_generation = entry.data.lock().unwrap().generation;
        // Only this host is serialized. Concurrent clients share its successful startup.
        let _gate = entry.connect_gate.lock().await;
        let (generation, cancel) = {
            let mut data = entry.data.lock().unwrap();
            if data.removed || self.shutdown.is_cancelled() {
                return Err(invalid("SSH 主机已移除或 miniQ 正在退出"));
            }
            if data
                .connection
                .as_ref()
                .is_some_and(|value| !value.cancel.is_cancelled())
            {
                drop(data);
                return Ok(entry.snapshot(host));
            }
            if data.generation != requested_generation {
                return Err(invalid("SSH 连接已被取消或替代"));
            }
            data.cancel.cancel();
            data.generation += 1;
            data.cancel = self.shutdown.child_token();
            data.connection = None;
            data.state = "connecting";
            data.error = None;
            (data.generation, data.cancel.clone())
        };
        changed(&self.events, host);
        let mut attempt = ConnectAttempt {
            entry: entry.clone(),
            generation,
            host: host.into(),
            events: self.events.clone(),
            active: true,
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err("SSH 连接已取消".into()),
            result = process::start(command) => result,
        };
        let mut data = entry.data.lock().unwrap();
        attempt.active = false;
        if data.generation != generation || data.removed || cancel.is_cancelled() {
            if data.generation == generation && !data.removed {
                data.state = "disconnected";
                drop(data);
                changed(&self.events, host);
            }
            return Err(invalid("SSH 连接已被取消或替代"));
        }
        match result {
            Ok(bridge) => {
                data.version = Some(bridge.version.clone());
                let (connection, ended) =
                    transport::Connection::start(bridge, host.into(), self.events.clone(), cancel);
                data.connection = Some(connection);
                data.state = "connected";
                watch_connection(
                    Arc::downgrade(&entry),
                    generation,
                    host.into(),
                    self.events.clone(),
                    ended,
                );
            }
            Err(message) => {
                data.state = "error";
                data.error = Some(message.clone());
                drop(data);
                changed(&self.events, host);
                return Err(failed(message));
            }
        }
        drop(data);
        changed(&self.events, host);
        Ok(entry.snapshot(host))
    }

    pub async fn call(
        &self,
        host: &str,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        if method.trim().is_empty()
            || method.starts_with("host.")
            || matches!(method, "daemon.shutdown" | "daemon.shutdownIfIdle")
        {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "不能通过 SSH 转发该管理操作",
            ));
        }
        let entry = self.hosts.get(host)?;
        let connection = entry
            .data
            .lock()
            .unwrap()
            .connection
            .clone()
            .ok_or_else(|| failed("SSH 主机未连接，请先连接主机"))?;
        connection.call(method, params).await
    }
}

fn watch_connection(
    entry: std::sync::Weak<Entry>,
    generation: u64,
    host: String,
    events: broadcast::Sender<Value>,
    ended: tokio::sync::oneshot::Receiver<String>,
) {
    tokio::spawn(async move {
        let error = ended.await.unwrap_or_else(|_| "SSH 连接已结束".into());
        let Some(entry) = entry.upgrade() else { return };
        let mut data = entry.data.lock().unwrap();
        if data.generation != generation || data.removed {
            return;
        }
        data.connection = None;
        data.state = "error";
        data.error = Some(error);
        drop(data);
        changed(&events, &host);
    });
}

struct ConnectAttempt {
    entry: Arc<Entry>,
    generation: u64,
    host: String,
    events: broadcast::Sender<Value>,
    active: bool,
}

impl Drop for ConnectAttempt {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut data = self.entry.data.lock().unwrap();
        if data.generation != self.generation {
            return;
        }
        data.cancel.cancel();
        data.state = "disconnected";
        drop(data);
        changed(&self.events, &self.host);
    }
}

impl Drop for SshHostManager {
    fn drop(&mut self) {
        self.hosts.disconnect_all();
    }
}

fn changed(events: &broadcast::Sender<Value>, host: &str) {
    let _ = events.send(json!({"type": "host_changed", "hostId": host}));
}

fn parse<T: serde::de::DeserializeOwned>(raw: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(raw.unwrap_or(Value::Null)).map_err(|error| invalid(error.to_string()))
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, message)
}
fn failed(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InternalError, message)
}
