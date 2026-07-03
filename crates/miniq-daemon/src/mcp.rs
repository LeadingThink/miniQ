//! MCP client manager: spawns configured MCP servers as child processes and
//! speaks JSON-RPC 2.0 over stdio (newline-delimited JSON, the MCP stdio
//! transport). Connections are created lazily and kept alive.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

const REQUEST_TIMEOUT_SECS: u64 = 30;
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
}

impl Connection {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let payload = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.send(&payload).await?;
        // Read lines until our response id shows up (notifications are skipped).
        let deadline = std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS);
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
        tokio::time::timeout(deadline, read)
            .await
            .map_err(|_| format!("MCP request {method} timed out"))?
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

pub struct McpManager {
    connections: Mutex<HashMap<String, Connection>>,
}

impl McpManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connections: Mutex::new(HashMap::new()),
        })
    }

    async fn connect(config: &McpServerConfig) -> Result<Connection, String> {
        let mut child = tokio::process::Command::new(&config.command)
            .args(&config.args)
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
        let mut connections = self.connections.lock().await;
        // Drop dead connections.
        if let Some(conn) = connections.get_mut(&config.name) {
            if conn.child.try_wait().map(|s| s.is_some()).unwrap_or(true) {
                connections.remove(&config.name);
            }
        }
        if !connections.contains_key(&config.name) {
            let conn = Self::connect(config).await?;
            connections.insert(config.name.clone(), conn);
        }
        let conn = connections.get_mut(&config.name).expect("just inserted");
        let result = conn.request(method, params).await;
        if result.is_err() {
            // Connection is suspect after an error; rebuild next time.
            connections.remove(&config.name);
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
        let mut connections = self.connections.lock().await;
        for (_, mut conn) in connections.drain() {
            let _ = conn.child.kill().await;
        }
    }
}

/// McpBridge implementation handed to the ToolRouter via ToolContext.
pub struct ManagerBridge {
    pub manager: Arc<McpManager>,
    pub servers: Vec<McpServerConfig>,
}

#[async_trait::async_trait]
impl miniq_tools::McpBridge for ManagerBridge {
    async fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<Value, String> {
        let config = self
            .servers
            .iter()
            .find(|s| s.name == server)
            .ok_or_else(|| format!("unknown MCP server: {server}"))?;
        self.manager.call_tool(config, tool, arguments).await
    }
}
