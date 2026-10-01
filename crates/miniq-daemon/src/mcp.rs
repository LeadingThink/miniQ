//! MCP client manager: spawns configured MCP servers as child processes and
//! speaks JSON-RPC 2.0 over stdio (newline-delimited JSON, the MCP stdio
//! transport). Connections are created lazily and kept alive.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

const REQUEST_TIMEOUT_SECS: u64 = 30;
/// Budget for `initialize` and the first request on a fresh connection.
/// Remote connectors launched through `mcp-remote` open a browser OAuth
/// login on first use and only answer once the user has signed in.
const HANDSHAKE_TIMEOUT_SECS: u64 = 180;
const PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Extra environment for the server process. The server otherwise only
    /// receives the subprocess allowlist (`miniq_local::subprocess_env`);
    /// `MINIQ_CREDENTIALS_PASSPHRASE` is always dropped.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

fn default_true() -> bool {
    true
}

/// One live stdio connection to an MCP server.
struct Connection {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: i64,
    /// True once a post-handshake request succeeded; until then requests
    /// get the longer handshake budget (OAuth may still be in progress).
    warmed: bool,
}

impl Connection {
    fn timeout_for(&self) -> std::time::Duration {
        std::time::Duration::from_secs(if self.warmed {
            REQUEST_TIMEOUT_SECS
        } else {
            HANDSHAKE_TIMEOUT_SECS
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let deadline = self.timeout_for();
        self.next_id += 1;
        let id = self.next_id;
        let payload = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.send(&payload).await?;
        // Read lines until our response id shows up (notifications are skipped).
        let read = async {
            let mut line = String::new();
            loop {
                line.clear();
                let n = self
                    .stdout
                    .read_line(&mut line)
                    .await
                    .map_err(|e| format!("read: {e}"))?;
                if n == 0 {
                    return Err("MCP server closed its stdout".to_string());
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if value.get("id").and_then(|i| i.as_i64()) == Some(id) {
                    if let Some(err) = value.get("error") {
                        return Err(format!("MCP error: {err}"));
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        };
        tokio::time::timeout(deadline, read).await.map_err(|_| {
            format!(
                "MCP request {method} timed out after {}s",
                deadline.as_secs()
            )
        })?
    }

    async fn send(&mut self, payload: &Value) -> Result<(), String> {
        let mut line = payload.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write: {e}"))
    }
}

/// One server's connection slot. Each server has its own lock so a slow
/// first handshake (e.g. an OAuth login through mcp-remote, up to
/// `HANDSHAKE_TIMEOUT_SECS`) never blocks calls to other servers.
type Slot = Arc<Mutex<Option<Connection>>>;

pub struct McpManager {
    connections: Mutex<HashMap<String, Slot>>,
}

impl McpManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connections: Mutex::new(HashMap::new()),
        })
    }

    fn command(config: &McpServerConfig) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&config.command);
        command.args(&config.args);
        miniq_local::subprocess_env::apply_allowlist(command.as_std_mut(), &config.env);
        command
    }

    async fn connect(config: &McpServerConfig) -> Result<Connection, String> {
        let mut child = Self::command(config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", config.command))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut conn = Connection {
            child,
            stdin,
            stdout,
            next_id: 0,
            warmed: false,
        };
        // MCP handshake.
        conn.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "miniQ", "version": env!("CARGO_PKG_VERSION")},
            }),
        )
        .await?;
        conn.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await?;
        Ok(conn)
    }

    /// Run `f`-style request against a named server, connecting lazily.
    async fn with_connection(
        &self,
        config: &McpServerConfig,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if !config.enabled {
            return Err(format!("MCP server {} is disabled", config.name));
        }
        let slot = {
            let mut connections = self.connections.lock().await;
            connections.entry(config.name.clone()).or_default().clone()
        };
        let mut guard = slot.lock().await;
        // Drop dead connections.
        if let Some(conn) = guard.as_mut() {
            if conn.child.try_wait().map(|s| s.is_some()).unwrap_or(true) {
                *guard = None;
            }
        }
        if guard.is_none() {
            *guard = Some(Self::connect(config).await?);
        }
        let conn = guard.as_mut().expect("just connected");
        let result = conn.request(method, params).await;
        if result.is_ok() {
            conn.warmed = true;
        } else {
            // Connection is suspect after an error; rebuild next time.
            *guard = None;
        }
        result
    }

    pub async fn list_tools(&self, config: &McpServerConfig) -> Result<Vec<Value>, String> {
        let result = self
            .with_connection(config, "tools/list", json!({}))
            .await?;
        Ok(result
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default())
    }

    pub async fn call_tool(
        &self,
        config: &McpServerConfig,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        self.with_connection(
            config,
            "tools/call",
            json!({"name": tool, "arguments": arguments}),
        )
        .await
    }

    pub async fn shutdown(&self) {
        let slots = {
            let mut connections = self.connections.lock().await;
            connections
                .drain()
                .map(|(_, slot)| slot)
                .collect::<Vec<_>>()
        };
        for slot in slots {
            Self::close(&slot).await;
        }
    }
    /// Close live connections whose server is no longer effective (e.g.
    /// after its plugin is disabled or uninstalled).
    pub async fn retain(&self, servers: &[McpServerConfig]) {
        let stale = {
            let mut connections = self.connections.lock().await;
            let names = connections
                .keys()
                .filter(|name| !servers.iter().any(|s| &s.name == *name && s.enabled))
                .cloned()
                .collect::<Vec<_>>();
            names
                .into_iter()
                .filter_map(|name| connections.remove(&name))
                .collect::<Vec<_>>()
        };
        for slot in stale {
            Self::close(&slot).await;
        }
    }

    /// Kill an idle slot's process now. A slot busy with an in-flight request
    /// has already been detached from the map; its process is killed on drop
    /// (`kill_on_drop`) once that request finishes.
    async fn close(slot: &Slot) {
        if let Ok(mut guard) = slot.try_lock() {
            if let Some(mut conn) = guard.take() {
                let _ = conn.child.kill().await;
            }
        }
    }
}

/// McpBridge implementation handed to the ToolRouter via ToolContext.
pub struct ManagerBridge {
    pub manager: Arc<McpManager>,
    pub servers: Vec<McpServerConfig>,
}

impl ManagerBridge {
    fn server(&self, server: &str) -> Result<&McpServerConfig, String> {
        self.servers
            .iter()
            .find(|s| s.name == server && s.enabled)
            .ok_or_else(|| {
                let available = self
                    .servers
                    .iter()
                    .filter(|s| s.enabled)
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>();
                if available.is_empty() {
                    format!("unknown MCP server: {server}; no MCP servers are enabled")
                } else {
                    format!(
                        "unknown MCP server: {server}; available servers: {}",
                        available.join(", ")
                    )
                }
            })
    }
}

#[async_trait::async_trait]
impl miniq_tools::McpBridge for ManagerBridge {
    async fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<Value, String> {
        let config = self.server(server)?;
        self.manager.call_tool(config, tool, arguments).await
    }

    async fn list_tools(&self, server: &str) -> Result<Vec<Value>, String> {
        let config = self.server(server)?;
        self.manager.list_tools(config).await
    }
}

/// A plugin-contributed server resolved into a runnable config, remembering
/// which plugin supplied it (for UI attribution).
#[derive(Debug, Clone)]
pub struct PluginMcpServerConfig {
    pub plugin_id: String,
    pub plugin_name: String,
    pub description: Option<String>,
    pub config: McpServerConfig,
}

/// Resolve plugin servers: `env` lists variable *names*; only those present
/// in `lookup` (the daemon's own environment in production) are forwarded.
pub fn resolve_plugin_servers(
    servers: Vec<miniq_plugins::EnabledPluginMcpServer>,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<PluginMcpServerConfig> {
    servers
        .into_iter()
        .map(|entry| {
            let env = entry
                .server
                .env
                .iter()
                .filter(|name| !miniq_local::subprocess_env::is_credentials_passphrase(name))
                .filter_map(|name| lookup(name).map(|value| (name.clone(), value)))
                .collect();
            PluginMcpServerConfig {
                plugin_id: entry.plugin_id,
                plugin_name: entry.plugin_name,
                description: entry.server.description.clone(),
                config: McpServerConfig {
                    name: entry.server.name,
                    command: entry.server.command,
                    args: entry.server.args,
                    enabled: true,
                    env,
                },
            }
        })
        .collect()
}

/// Effective server list: user settings first, then plugin servers whose
/// names do not collide (settings win; collisions are skipped with a warn).
pub fn merge_servers(
    settings: &[McpServerConfig],
    plugins: &[PluginMcpServerConfig],
) -> Vec<McpServerConfig> {
    let mut merged = settings.to_vec();
    for plugin in plugins {
        if merged.iter().any(|s| s.name == plugin.config.name) {
            tracing::warn!(
                server = %plugin.config.name,
                plugin = %plugin.plugin_id,
                "plugin MCP server skipped: name already used by another server"
            );
            continue;
        }
        merged.push(plugin.config.clone());
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdio_server_env_is_allowlisted() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "name": "demo",
            "command": "demo-server",
            "env": {
                "DEMO_TOKEN": "configured",
                "MINIQ_CREDENTIALS_PASSPHRASE": "never"
            }
        }))
        .unwrap();
        let command = McpManager::command(&config);
        let envs = command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
            .collect::<HashMap<_, _>>();
        assert_eq!(
            envs.get(std::ffi::OsStr::new("DEMO_TOKEN")).unwrap(),
            "configured"
        );
        assert!(!envs.contains_key(std::ffi::OsStr::new("MINIQ_CREDENTIALS_PASSPHRASE")));
        for key in envs.keys() {
            let key = key.to_string_lossy();
            assert!(
                key == "DEMO_TOKEN"
                    || key.starts_with("LC_")
                    || ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"].contains(&key.as_ref())
                    || cfg!(windows),
                "unexpected inherited variable {key}"
            );
        }
    }

    #[test]
    fn env_field_defaults_to_empty_and_is_omitted() {
        let config: McpServerConfig =
            serde_json::from_value(json!({"name": "demo", "command": "demo"})).unwrap();
        assert!(config.env.is_empty());
        assert!(serde_json::to_value(&config).unwrap().get("env").is_none());
    }

    fn plugin_entry(
        plugin: &str,
        name: &str,
        env: &[&str],
    ) -> miniq_plugins::EnabledPluginMcpServer {
        miniq_plugins::EnabledPluginMcpServer {
            plugin_id: plugin.into(),
            plugin_name: plugin.into(),
            server: miniq_plugins::PluginMcpServer {
                name: name.into(),
                description: Some("desc".into()),
                command: "npx".into(),
                args: vec!["-y".into(), "mcp-remote@latest".into()],
                env: env.iter().map(|value| value.to_string()).collect(),
            },
        }
    }

    #[test]
    fn plugin_env_forwards_only_present_daemon_variables() {
        let lookup = |name: &str| match name {
            "LINEAR_TOKEN" => Some("abc".to_string()),
            "MINIQ_CREDENTIALS_PASSPHRASE" => Some("never".to_string()),
            _ => None,
        };
        let resolved = resolve_plugin_servers(
            vec![plugin_entry(
                "dev.linear",
                "linear",
                &[
                    "LINEAR_TOKEN",
                    "MISSING_VAR",
                    "MINIQ_CREDENTIALS_PASSPHRASE",
                ],
            )],
            lookup,
        );
        assert_eq!(resolved.len(), 1);
        let config = &resolved[0].config;
        assert_eq!(resolved[0].plugin_id, "dev.linear");
        assert!(config.enabled);
        assert_eq!(config.args, vec!["-y", "mcp-remote@latest"]);
        assert_eq!(
            config.env,
            BTreeMap::from([("LINEAR_TOKEN".to_string(), "abc".to_string())])
        );
        // The spawn path still applies the allowlist on top.
        let command = McpManager::command(config);
        let envs = command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
            .collect::<HashMap<_, _>>();
        assert_eq!(
            envs.get(std::ffi::OsStr::new("LINEAR_TOKEN")).unwrap(),
            "abc"
        );
        assert!(!envs.contains_key(std::ffi::OsStr::new("MINIQ_CREDENTIALS_PASSPHRASE")));
    }

    #[test]
    fn settings_servers_win_name_collisions() {
        let settings: Vec<McpServerConfig> = serde_json::from_value(json!([
            {"name": "linear", "command": "user-linear"},
            {"name": "local", "command": "local", "enabled": false}
        ]))
        .unwrap();
        let plugins = resolve_plugin_servers(
            vec![
                plugin_entry("dev.linear", "linear", &[]),
                plugin_entry("dev.notion", "notion", &[]),
            ],
            |_| None,
        );
        let merged = merge_servers(&settings, &plugins);
        let names = merged.iter().map(|s| s.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, vec!["linear", "local", "notion"]);
        assert_eq!(merged[0].command, "user-linear");
        assert_eq!(merged[2].command, "npx");
        assert!(merge_servers(&[], &[]).is_empty());
    }
}
