//! Per-turn effective tool set.
//!
//! The router holds every registered tool, but a session may only see and
//! call the subset that is currently effective: tools of disabled plugins are
//! excluded, `mcp_call` requires at least one enabled MCP server, and each
//! `mcp_call` is additionally checked against its inner `mcp:<server>:<tool>`
//! target. The set is recomputed from live state for every model request and
//! every call, so enable/disable changes apply within the same turn.

use std::collections::BTreeSet;

use miniq_models::{ToolCallRequest, ToolSpec};
use miniq_tools::ToolOrigin;
use serde_json::{json, Value};

use super::SessionToolExecutor;

pub(super) const NOT_IN_EFFECTIVE_SET: &str = "TOOL_NOT_IN_EFFECTIVE_SET";

/// Identity of one allowed tool: the origin plus the tool name. MCP targets
/// use `mcp:<server>` as origin and the inner tool name.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct EffectiveKey {
    pub origin: String,
    pub tool: String,
}

#[derive(Debug, Clone, Default)]
pub(super) struct EffectiveSet {
    pub specs: Vec<ToolSpec>,
    pub allowed: BTreeSet<EffectiveKey>,
    /// Enabled MCP servers; any tool on them is allowed through `mcp_call`.
    pub mcp_servers: BTreeSet<String>,
}

impl EffectiveSet {
    pub fn contains_tool(&self, name: &str) -> bool {
        self.allowed.iter().any(|key| key.tool == name)
    }

    pub fn contains_mcp(&self, server: &str, tool: &str) -> bool {
        !tool.trim().is_empty() && self.mcp_servers.contains(server)
    }

    pub fn names(&self) -> Vec<String> {
        self.specs.iter().map(|spec| spec.name.clone()).collect()
    }
}

fn origin_label(origin: &ToolOrigin) -> String {
    match origin {
        ToolOrigin::Builtin => "builtin".into(),
        ToolOrigin::Plugin { id, .. } => format!("plugin:{id}"),
    }
}

impl SessionToolExecutor {
    /// Compute the effective set from live router, plugin and MCP state.
    pub(super) fn effective_set(&self) -> EffectiveSet {
        // Settings servers plus enabled plugins' servers: a plugin server is
        // available by default while its plugin is enabled (enabling the
        // plugin is the opt-in); settings win on name collisions.
        let mcp_servers = self
            .state
            .effective_mcp_servers()
            .into_iter()
            .filter(|server| server.enabled)
            .map(|server| server.name)
            .collect::<BTreeSet<_>>();
        let mut set = EffectiveSet {
            mcp_servers,
            ..Default::default()
        };
        for spec in self.router.specs() {
            let Some(origin) = self.router.origin(&spec.name) else {
                continue;
            };
            if let ToolOrigin::Plugin { id, .. } = &origin {
                // Unknown to the manager means registered directly on the
                // router (embedders/tests); the registration is authoritative.
                if self
                    .state
                    .plugins
                    .diagnostics(id)
                    .is_some_and(|info| !info.enabled)
                {
                    continue;
                }
            }
            if spec.name == "mcp_call" && set.mcp_servers.is_empty() {
                continue;
            }
            set.allowed.insert(EffectiveKey {
                origin: origin_label(&origin),
                tool: spec.name.clone(),
            });
            set.specs.push(spec);
        }
        set
    }

    /// `Some(output)` when the (already resolved) call is outside the
    /// effective set. Such calls never reach approval or execution.
    pub(super) fn effective_set_rejection(&self, call: &ToolCallRequest) -> Option<Value> {
        let set = self.effective_set();
        if call.name == "mcp_call" {
            // Judge the inner target, not just the wrapper tool (RT-07).
            let server = call.arguments["server"].as_str().unwrap_or_default();
            let tool = call.arguments["tool"].as_str().unwrap_or_default();
            if !set.contains_tool("mcp_call") || !set.contains_mcp(server, tool) {
                return Some(rejection(
                    &format!("mcp:{server}:{tool}"),
                    format!("MCP server {server:?} is not configured or is disabled"),
                    &set,
                ));
            }
        } else if !set.contains_tool(&call.name) {
            return Some(rejection(
                &call.name,
                format!("tool {} is not enabled for this session", call.name),
                &set,
            ));
        }
        None
    }
}

fn rejection(requested: &str, message: String, set: &EffectiveSet) -> Value {
    json!({
        "error": {
            "code": NOT_IN_EFFECTIVE_SET,
            "message": message,
            "requestedTool": requested,
            "availableTools": set.names(),
            "enabledMcpServers": set.mcp_servers,
            "recovery": "Use only availableTools (and enabled MCP servers); do not retry this call."
        }
    })
}
