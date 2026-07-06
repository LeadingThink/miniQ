//! Tool trait and router.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use miniq_models::ToolSpec;
use miniq_sandbox::Risk;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("sandbox denied: {0}")]
    SandboxDenied(String),
    #[error("execution failed: {0}")]
    ExecutionFailed(String),
}

/// Everything a tool needs to run. Tools must not reach outside this context.
#[derive(Clone)]
pub struct ToolContext {
    /// Absolute workspace root; all paths and cwd are constrained to it.
    pub workspace: PathBuf,
    /// Search provider config; `None` = web_search uses the free fallback chain.
    pub search: Option<crate::web_search::SearchConfig>,
    /// Skill store; `None` = skill_read unavailable.
    pub skills: Option<Arc<miniq_skills::SkillStore>>,
    /// SQLite store for memory tools; `None` = memory tools unavailable.
    pub memory: Option<Arc<miniq_memory::Store>>,
    /// Workspace id for workspace-scoped memory.
    pub workspace_id: Option<String>,
    /// MCP bridge; `None` = mcp_call unavailable.
    pub mcp: Option<Arc<dyn crate::mcp::McpBridge>>,
}

impl ToolContext {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            search: None,
            skills: None,
            memory: None,
            workspace_id: None,
            mcp: None,
        }
    }

    pub fn with_mcp(mut self, mcp: Option<Arc<dyn crate::mcp::McpBridge>>) -> Self {
        self.mcp = mcp;
        self
    }

    pub fn with_memory(
        mut self,
        memory: Option<Arc<miniq_memory::Store>>,
        workspace_id: Option<String>,
    ) -> Self {
        self.memory = memory;
        self.workspace_id = workspace_id;
        self
    }

    pub fn with_search(mut self, search: Option<crate::web_search::SearchConfig>) -> Self {
        self.search = search;
        self
    }

    pub fn with_skills(mut self, skills: Option<Arc<miniq_skills::SkillStore>>) -> Self {
        self.skills = skills;
        self
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON Schema for the tool input object.
    fn parameters_schema(&self) -> Value;
    /// Risk of executing `input` in `ctx` (checked before execution).
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk;
    /// Execute. Input has already been risk-checked by the router; path
    /// containment must still be enforced here.
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError>;

    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name().to_string(),
            description: self.description().to_string(),
            parameters: self.parameters_schema(),
        }
    }
}

#[derive(Default)]
pub struct ToolRouter {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = self.tools.values().map(|t| t.spec()).collect();
        specs.sort_by(|a, b| a.name.cmp(&b.name));
        specs
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    /// Evaluate risk without executing.
    pub fn evaluate(&self, ctx: &ToolContext, name: &str, input: &Value) -> Result<Risk, ToolError> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| ToolError::UnknownTool(name.to_string()))?;
        Ok(tool.evaluate_risk(ctx, input))
    }

    /// Execute a tool. Risk gating and approval are the caller's job; this
    /// only dispatches.
    pub async fn dispatch(
        &self,
        ctx: &ToolContext,
        name: &str,
        input: Value,
    ) -> Result<Value, ToolError> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| ToolError::UnknownTool(name.to_string()))?;
        tool.execute(ctx, input).await
    }
}

/// Helper: deserialize tool input with a uniform error.
pub(crate) fn parse_input<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))
}
