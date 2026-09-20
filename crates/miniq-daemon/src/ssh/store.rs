//! Persist only approved targets. Runtime connection state is never restored on startup.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use miniq_protocol::RpcError;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{failed, invalid, transport::Connection};

pub(super) struct Entry {
    pub data: Mutex<EntryData>,
    pub connect_gate: tokio::sync::Mutex<()>,
}

pub(super) struct EntryData {
    pub generation: u64,
    pub cancel: CancellationToken,
    pub removed: bool,
    pub state: &'static str,
    pub version: Option<String>,
    pub error: Option<String>,
    pub connection: Option<Arc<Connection>>,
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            data: Mutex::new(EntryData {
                generation: 0,
                cancel: CancellationToken::new(),
                removed: false,
                state: "disconnected",
                version: None,
                error: None,
                connection: None,
            }),
            connect_gate: tokio::sync::Mutex::new(()),
        }
    }
}

impl Entry {
    pub fn snapshot(&self, host: &str) -> Value {
        let data = self.data.lock().unwrap();
        let mut value = json!({"hostId": host, "label": host, "state": data.state});
        if let Some(version) = &data.version {
            value["version"] = json!(version);
        }
        if let Some(error) = &data.error {
            value["error"] = json!(error);
        }
        value
    }

    pub fn disconnect(&self, removed: bool) {
        let mut data = self.data.lock().unwrap();
        data.generation += 1;
        data.cancel.cancel();
        data.connection = None;
        data.removed |= removed;
        data.state = "disconnected";
        data.error = None;
    }
}

pub(super) struct HostStore {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    load_error: Option<String>,
}

impl HostStore {
    pub fn load(path: PathBuf) -> Self {
        let loaded = (|| -> Result<Vec<String>, String> {
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(format!("无法读取已保存的 SSH 主机：{error}")),
            };
            let hosts: Vec<String> = serde_json::from_str(&text)
                .map_err(|error| format!("SSH 主机配置格式无效：{error}"))?;
            for host in &hosts {
                super::config::validate_host(host)?;
            }
            Ok(hosts)
        })();
        let (entries, load_error) = match loaded {
            Ok(hosts) => (
                hosts
                    .into_iter()
                    .map(|host| (host, Arc::new(Entry::default())))
                    .collect(),
                None,
            ),
            Err(error) => (BTreeMap::new(), Some(error)),
        };
        Self {
            path,
            entries: Mutex::new(entries),
            load_error,
        }
    }

    fn check(&self) -> Result<(), RpcError> {
        match &self.load_error {
            Some(error) => Err(failed(error.clone())),
            None => Ok(()),
        }
    }

    pub fn list(&self) -> Result<Vec<Value>, RpcError> {
        self.check()?;
        Ok(self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(host, entry)| entry.snapshot(host))
            .collect())
    }

    pub fn get(&self, host: &str) -> Result<Arc<Entry>, RpcError> {
        self.check()?;
        self.entries
            .lock()
            .unwrap()
            .get(host)
            .cloned()
            .ok_or_else(|| invalid("请先在桌面端添加该 SSH 主机"))
    }

    pub fn save(&self, host: &str) -> Result<Arc<Entry>, RpcError> {
        self.check()?;
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.get(host) {
            return Ok(entry.clone());
        }
        let hosts: Vec<_> = entries
            .keys()
            .map(String::as_str)
            .chain(std::iter::once(host))
            .collect();
        miniq_local::write_private_json(&self.path, &hosts)
            .map_err(|error| failed(error.to_string()))?;
        let entry = Arc::new(Entry::default());
        entries.insert(host.into(), entry.clone());
        Ok(entry)
    }

    pub fn remove(&self, host: &str) -> Result<Option<Arc<Entry>>, RpcError> {
        self.check()?;
        let mut entries = self.entries.lock().unwrap();
        let hosts: Vec<_> = entries
            .keys()
            .filter(|value| value.as_str() != host)
            .collect();
        miniq_local::write_private_json(&self.path, &hosts)
            .map_err(|error| failed(error.to_string()))?;
        Ok(entries.remove(host))
    }

    pub fn disconnect_all(&self) {
        for entry in self.entries.lock().unwrap().values() {
            entry.disconnect(false);
        }
    }
}
