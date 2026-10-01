//! mcp_call: invoke a tool on a configured MCP server. The actual MCP
//! client lives in the daemon behind [`McpBridge`]; this tool only routes
//! through it so MCP calls flow through the normal risk/approval/audit
//! chain.
//!
//! Discovery: `tool = "tools/list"` returns the server's tool catalog
//! (`name`, `description`, `inputSchema`) instead of calling a tool, so the
//! model can list first and then call with correct arguments.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

/// Pseudo tool name that lists a server's tools instead of calling one.
pub const MCP_LIST_TOOLS: &str = "tools/list";

/// Daemon-side MCP client interface.
#[async_trait]
pub trait McpBridge: Send + Sync {
    /// Call `tool` on `server` with `arguments`.
    async fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<Value, String>;

    /// The server's tool catalog, each entry reduced to
    /// `{name, description, inputSchema}`. Unknown servers must produce an
    /// error that names the available servers.
    async fn list_tools(&self, server: &str) -> Result<Vec<Value>, String>;
}

pub struct McpCallTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpCallInput {
    server: String,
    tool: String,
    #[serde(default)]
    arguments: Option<Value>,
}

fn is_list_tools(input: &Value) -> bool {
    input.get("tool").and_then(Value::as_str) == Some(MCP_LIST_TOOLS)
}

/// Keep only the documented discovery fields of an MCP tool descriptor.
fn summarize_tool(tool: &Value) -> Value {
    json!({
        "name": tool.get("name").cloned().unwrap_or(Value::Null),
        "description": tool.get("description").cloned().unwrap_or(Value::Null),
        "inputSchema": tool
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object"})),
    })
}

#[async_trait]
impl Tool for McpCallTool {
    fn name(&self) -> &str {
        "mcp_call"
    }
    fn description(&self) -> &str {
        "Call a tool on a configured MCP server (external integration / connector). \
         First discover the server's tools with tool=\"tools/list\" (no arguments): it \
         returns each tool's name, description and inputSchema. Then call a listed tool \
         by name with arguments matching its inputSchema. Never guess tool names. \
         Calling tools requires approval per server."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": {"type": "string", "description": "Configured MCP server name"},
                "tool": {
                    "type": "string",
                    "description": "Tool name on that server, or \"tools/list\" to list the server's tools"
                },
                "arguments": {"type": "object", "description": "Tool arguments (ignored for tools/list)"}
            },
            "required": ["server", "tool"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        let server = input.get("server").and_then(|s| s.as_str()).unwrap_or("?");
        if is_list_tools(input) {
            // Listing is read-only on the remote side, but the first use may
            // launch the server's local process (e.g. `npx ...`), which is
            // code execution. Medium keeps an approval prompt in Always Ask
            // mode while Auto mode can discover tools without friction.
            return Risk {
                level: RiskLevel::Medium,
                reason: format!("list tools of MCP server {server} (may start its local process)"),
            };
        }
        Risk {
            level: RiskLevel::High,
            reason: format!("external MCP tool on server {server}"),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: McpCallInput = parse_input(input)?;
        let Some(bridge) = &ctx.mcp else {
            return Err(ToolError::ExecutionFailed(
                "no MCP servers are configured".into(),
            ));
        };
        if p.tool == MCP_LIST_TOOLS {
            let tools = bridge
                .list_tools(&p.server)
                .await
                .map_err(ToolError::ExecutionFailed)?;
            return Ok(json!({
                "server": p.server,
                "tools": tools.iter().map(summarize_tool).collect::<Vec<_>>(),
            }));
        }
        bridge
            .call(&p.server, &p.tool, p.arguments.unwrap_or_else(|| json!({})))
            .await
            .map_err(ToolError::ExecutionFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeBridge {
        calls: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl McpBridge for FakeBridge {
        async fn call(&self, server: &str, tool: &str, _arguments: Value) -> Result<Value, String> {
            self.calls.lock().unwrap().push(format!("{server}:{tool}"));
            Ok(json!({"ok": true}))
        }
        async fn list_tools(&self, server: &str) -> Result<Vec<Value>, String> {
            if server != "linear" {
                return Err(format!(
                    "unknown MCP server {server}; available servers: linear"
                ));
            }
            Ok(vec![json!({
                "name": "create_issue",
                "description": "Create an issue",
                "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}},
                "annotations": {"ignored": true}
            })])
        }
    }

    fn ctx(bridge: Arc<FakeBridge>) -> ToolContext {
        ToolContext::new(std::env::temp_dir()).with_mcp(Some(bridge))
    }

    #[tokio::test]
    async fn tools_list_returns_catalog_without_calling() {
        let bridge = Arc::new(FakeBridge::default());
        let output = McpCallTool
            .execute(
                &ctx(bridge.clone()),
                json!({"server": "linear", "tool": "tools/list"}),
            )
            .await
            .unwrap();
        assert_eq!(output["server"], "linear");
        assert_eq!(
            output["tools"],
            json!([{
                "name": "create_issue",
                "description": "Create an issue",
                "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}}
            }])
        );
        assert!(bridge.calls.lock().unwrap().is_empty());

        McpCallTool
            .execute(
                &ctx(bridge.clone()),
                json!({"server": "linear", "tool": "create_issue", "arguments": {"title": "x"}}),
            )
            .await
            .unwrap();
        assert_eq!(*bridge.calls.lock().unwrap(), vec!["linear:create_issue"]);
    }

    #[tokio::test]
    async fn tools_list_unknown_server_names_available_servers() {
        let error = McpCallTool
            .execute(
                &ctx(Arc::new(FakeBridge::default())),
                json!({"server": "nope", "tool": "tools/list"}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("available servers: linear"));
    }

    #[test]
    fn tools_list_is_medium_and_calls_stay_high() {
        let ctx = ToolContext::new(std::env::temp_dir());
        let list = McpCallTool.evaluate_risk(&ctx, &json!({"server": "s", "tool": "tools/list"}));
        assert_eq!(list.level, RiskLevel::Medium);
        let call = McpCallTool.evaluate_risk(&ctx, &json!({"server": "s", "tool": "create"}));
        assert_eq!(call.level, RiskLevel::High);
        assert!(McpCallTool.description().contains("tools/list"));
    }
}
