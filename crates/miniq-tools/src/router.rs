//! Tool trait and router.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

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

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RegistrationError {
    #[error("tool already registered: {0}")]
    AlreadyRegistered(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolOrigin {
    Builtin,
    Plugin {
        id: String,
        runtime: String,
        version: String,
    },
}

pub type ToolCatalog = Arc<dyn Fn() -> Vec<ToolSpec> + Send + Sync>;

/// Everything a tool needs to run. Tools must not reach outside this context.
#[derive(Clone)]
pub struct ToolContext {
    /// Absolute workspace root; all paths and cwd are constrained to it.
    pub workspace: PathBuf,
    /// Skill store; `None` = skill_read unavailable.
    pub skills: Option<Arc<miniq_skills::SkillStore>>,
    /// SQLite store for memory tools; `None` = memory tools unavailable.
    pub memory: Option<Arc<miniq_memory::Store>>,
    /// Workspace id for workspace-scoped memory.
    pub workspace_id: Option<String>,
    /// MCP bridge; `None` = mcp_call unavailable.
    pub mcp: Option<Arc<dyn crate::mcp::McpBridge>>,
    /// Processes started by background shell calls. Shared across turns so a
    /// later TaskOutput or KillShell call can address the same handle.
    pub processes: Arc<crate::process::ProcessManager>,
    /// Host-provided child-agent runtime. None outside daemon sessions.
    pub agents: Option<Arc<dyn crate::agent::AgentBridge>>,
    /// Structured task graph shared by all executors in the daemon.
    pub tasks: Arc<crate::tasks::TaskManager>,
    /// Namespace used to isolate task graphs between sessions.
    pub task_scope: String,
    /// Plan-mode guard shared by the executor and plan_mode tool.
    plan_mode: Arc<AtomicBool>,
}

impl ToolContext {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            skills: None,
            memory: None,
            workspace_id: None,
            mcp: None,
            processes: Arc::new(crate::process::ProcessManager::default()),
            agents: None,
            tasks: Arc::new(crate::tasks::TaskManager::default()),
            task_scope: String::new(),
            plan_mode: Arc::new(AtomicBool::new(false)),
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

    pub fn with_skills(mut self, skills: Option<Arc<miniq_skills::SkillStore>>) -> Self {
        self.skills = skills;
        self
    }

    pub fn with_processes(mut self, processes: Arc<crate::process::ProcessManager>) -> Self {
        self.processes = processes;
        self
    }

    pub fn with_agents(mut self, agents: Option<Arc<dyn crate::agent::AgentBridge>>) -> Self {
        self.agents = agents;
        self
    }

    pub fn with_tasks(
        mut self,
        tasks: Arc<crate::tasks::TaskManager>,
        task_scope: impl Into<String>,
    ) -> Self {
        self.tasks = tasks;
        self.task_scope = task_scope.into();
        self
    }

    pub fn plan_mode(&self) -> bool {
        self.plan_mode.load(Ordering::SeqCst)
    }

    pub fn set_plan_mode(&self, active: bool) {
        self.plan_mode.store(active, Ordering::SeqCst);
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

pub struct ToolRouter {
    tools: Arc<RwLock<BTreeMap<String, RegisteredTool>>>,
    next_id: std::sync::atomic::AtomicU64,
}

struct RegisteredTool {
    id: u64,
    tool: Arc<dyn Tool>,
    origin: ToolOrigin,
}

pub struct RegistrationHandle {
    tools: Arc<RwLock<BTreeMap<String, RegisteredTool>>>,
    name: String,
    id: u64,
    disposed: bool,
}

impl Default for ToolRouter {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRouter {
    pub fn new() -> Self {
        Self {
            tools: Arc::new(RwLock::new(BTreeMap::new())),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    pub fn register(&self, tool: Arc<dyn Tool>) -> Result<RegistrationHandle, RegistrationError> {
        self.register_inner(tool, ToolOrigin::Builtin)
    }

    pub fn register_plugin(
        &self,
        tool: Arc<dyn Tool>,
        id: String,
        runtime: String,
        version: String,
    ) -> Result<RegistrationHandle, RegistrationError> {
        self.register_inner(
            tool,
            ToolOrigin::Plugin {
                id,
                runtime,
                version,
            },
        )
    }

    pub fn register_builtin(&self, tool: Arc<dyn Tool>) -> Result<(), RegistrationError> {
        let name = tool.name().to_string();
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut tools = self.tools.write().unwrap();
        if tools.contains_key(&name) {
            return Err(RegistrationError::AlreadyRegistered(name));
        }
        tools.insert(
            name,
            RegisteredTool {
                id,
                tool,
                origin: ToolOrigin::Builtin,
            },
        );
        Ok(())
    }

    fn register_inner(
        &self,
        tool: Arc<dyn Tool>,
        origin: ToolOrigin,
    ) -> Result<RegistrationHandle, RegistrationError> {
        let name = tool.name().to_string();
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut tools = self.tools.write().unwrap();
        if tools.contains_key(&name) {
            return Err(RegistrationError::AlreadyRegistered(name));
        }
        tools.insert(name.clone(), RegisteredTool { id, tool, origin });
        Ok(RegistrationHandle {
            tools: Arc::clone(&self.tools),
            name,
            id,
            disposed: false,
        })
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools
            .read()
            .unwrap()
            .values()
            .map(|entry| entry.tool.spec())
            .collect()
    }

    pub fn catalog(&self) -> ToolCatalog {
        let tools = Arc::downgrade(&self.tools);
        Arc::new(move || {
            tools
                .upgrade()
                .map(|tools| {
                    tools
                        .read()
                        .unwrap()
                        .values()
                        .map(|entry| entry.tool.spec())
                        .collect()
                })
                .unwrap_or_default()
        })
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools
            .read()
            .unwrap()
            .get(name)
            .map(|entry| Arc::clone(&entry.tool))
    }

    pub fn origin(&self, name: &str) -> Option<ToolOrigin> {
        self.tools
            .read()
            .unwrap()
            .get(name)
            .map(|entry| entry.origin.clone())
    }

    /// Evaluate risk without executing.
    pub fn evaluate(
        &self,
        ctx: &ToolContext,
        name: &str,
        input: &Value,
    ) -> Result<Risk, ToolError> {
        let tool = self
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
            .get(name)
            .ok_or_else(|| ToolError::UnknownTool(name.to_string()))?;
        tool.execute(ctx, input).await
    }
}

impl RegistrationHandle {
    pub fn dispose(mut self) {
        if !self.disposed {
            let mut tools = self.tools.write().unwrap();
            if tools
                .get(&self.name)
                .is_some_and(|entry| entry.id == self.id)
            {
                tools.remove(&self.name);
            }
            self.disposed = true;
        }
    }
}

impl Drop for RegistrationHandle {
    fn drop(&mut self) {
        if !self.disposed {
            let mut tools = self.tools.write().unwrap();
            if tools
                .get(&self.name)
                .is_some_and(|entry| entry.id == self.id)
            {
                tools.remove(&self.name);
            }
        }
    }
}

/// Helper: deserialize tool input with a uniform error.
pub(crate) fn parse_input<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestTool(&'static str);

    #[async_trait]
    impl Tool for TestTool {
        fn name(&self) -> &str {
            self.0
        }
        fn description(&self) -> &str {
            "test"
        }
        fn parameters_schema(&self) -> Value {
            serde_json::json!({"type": "object"})
        }
        fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
            Risk {
                level: miniq_protocol::RiskLevel::Low,
                reason: "test".into(),
            }
        }
        async fn execute(&self, _ctx: &ToolContext, _input: Value) -> Result<Value, ToolError> {
            Ok(Value::Null)
        }
    }

    #[test]
    fn registrations_are_ordered_and_revocable() {
        let router = ToolRouter::new();
        let first = router.register(Arc::new(TestTool("zeta"))).unwrap();
        let second = router.register(Arc::new(TestTool("alpha"))).unwrap();
        assert_eq!(
            router
                .specs()
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "zeta"]
        );
        second.dispose();
        assert_eq!(router.specs().len(), 1);
        drop(first);
        assert!(router.specs().is_empty());
    }

    #[test]
    fn duplicate_names_are_rejected_including_builtins() {
        let router = ToolRouter::new();
        router.register_builtin(Arc::new(TestTool("same"))).unwrap();
        let error = match router.register(Arc::new(TestTool("same"))) {
            Ok(_) => panic!("duplicate tool registration must fail"),
            Err(error) => error,
        };
        assert_eq!(error, RegistrationError::AlreadyRegistered("same".into()));
    }
}
