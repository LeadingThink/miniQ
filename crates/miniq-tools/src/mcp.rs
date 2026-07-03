//! mcp_call: invoke a tool on a configured MCP server. The actual MCP
//! client lives in the daemon behind [`McpBridge`]; this tool only routes
//! through it so MCP calls flow through the normal risk/approval/audit
//! chain.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

/// Daemon-side MCP client interface.
#[async_trait]
pub trait McpBridge: Send + Sync {
    /// Call `tool` on `server` with `arguments`.
    async fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<Value, String>;
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

#[async_trait]
impl Tool for McpCallTool {
    fn name(&self) -> &str {
        "mcp_call"
    }
    fn description(&self) -> &str {
        "Call a tool on a configured MCP server (external integration). Use mcp.list \
         via the UI to see available servers and tools. Requires approval per server."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": {"type": "string", "description": "Configured MCP server name"},
                "tool": {"type": "string", "description": "Tool name on that server"},
                "arguments": {"type": "object", "description": "Tool arguments"}
            },
            "required": ["server", "tool"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        let server = input.get("server").and_then(|s| s.as_str()).unwrap_or("?");
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
        bridge
            .call(&p.server, &p.tool, p.arguments.unwrap_or_else(|| json!({})))
            .await
            .map_err(ToolError::ExecutionFailed)
    }
}
