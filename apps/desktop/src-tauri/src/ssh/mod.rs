//! SSH host connections are independent from the local daemon lifecycle.

mod config;
mod process;
mod proxy;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub use config::{hosts, SshHost};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub port: u16,
    pub token: String,
    pub host: String,
    pub version: String,
}

struct Connection {
    info: ConnectionInfo,
    proxy: proxy::Proxy,
}

#[derive(Default)]
pub struct SshConnections {
    active: tokio::sync::Mutex<Option<Connection>>,
    generation: AtomicU64,
    exiting: AtomicBool,
}

impl SshConnections {
    pub async fn connect(&self, host: &str) -> Result<ConnectionInfo, String> {
        config::validate_host(host)?;
        self.connect_with(host, process::ssh_command(host)).await
    }

    async fn connect_with(
        &self,
        host: &str,
        command: tokio::process::Command,
    ) -> Result<ConnectionInfo, String> {
        if self.exiting.load(Ordering::SeqCst) {
            return Err("miniQ 正在退出，无法建立 SSH 连接".into());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut active = self.active.lock().await;
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err("SSH 连接已被较新的连接操作替代".into());
        }
        if let Some(connection) = active.as_ref() {
            if connection.info.host == host && connection.proxy.alive.load(Ordering::SeqCst) {
                return Ok(connection.info.clone());
            }
        }
        // Preserve the active host if the new host cannot authenticate or launch.
        let bridge = process::start(command).await?;
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err("SSH 连接已被较新的连接操作替代".into());
        }
        let version = bridge.version.clone();
        let proxy = proxy::Proxy::start(bridge).await?;
        if self.generation.load(Ordering::SeqCst) != generation {
            proxy.stop().await;
            return Err("SSH 连接已被较新的连接操作替代".into());
        }
        let info = ConnectionInfo {
            port: proxy.port,
            token: proxy.token.clone(),
            host: host.into(),
            version,
        };
        if let Some(previous) = active.replace(Connection {
            info: info.clone(),
            proxy,
        }) {
            previous.proxy.stop().await;
        }
        Ok(info)
    }

    pub async fn disconnect(&self) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut active = self.active.lock().await;
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(connection) = active.take() {
            connection.proxy.stop().await;
        }
    }

    pub fn begin_shutdown(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

impl Drop for SshConnections {
    fn drop(&mut self) {
        if let Some(connection) = self.active.get_mut().take() {
            connection.proxy.cancel.cancel();
        }
    }
}
