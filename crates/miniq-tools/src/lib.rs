//! miniq-tools: built-in tools and the ToolRouter.
//!
//! Tools expose their capability through the [`Tool`] trait and are invoked
//! exclusively through [`ToolRouter`], which validates input, evaluates risk
//! and dispatches. Approval and persistence are handled by the caller (the
//! daemon) around `dispatch`.

mod agent;
mod apply_patch;
mod apply_patch_diff;
mod browser;
mod catalog;
mod doc;
mod edit;
mod file;
mod git;
mod http;
mod interact;
mod mcp;
mod memory;
mod native;
mod notebook;
mod patch;
mod plan_mode;
mod process;
mod router;
mod search;
mod shell;
mod skill;
mod tasks;
mod web;
mod web_search;

pub use agent::{
    AgentBridge, AgentMessageRequest, AgentMessageTool, AgentRunRequest, AgentRunTool,
};
pub use apply_patch::{affected_paths as apply_patch_affected_paths, ApplyPatchTool};
pub use browser::BrowserAutomationTool;
pub use catalog::ToolSearchTool;
pub use doc::{DocReadTool, DocWriteTool};
pub use edit::FileEditTool;
pub use file::{FileListTool, FileReadTool, FileWriteTool};
pub use git::{GitDiffTool, GitStatusTool};
pub use http::HttpRequestTool;
pub use interact::{validate_ask_user_input, AskUserTool, TaskUpdateTool};
pub use mcp::{McpBridge, McpCallTool};
pub use memory::{MemorySearchTool, MemoryWriteTool};
pub use native::{
    adapt_native_tool_call, canonical_name as canonical_native_tool_name, native_aliases,
    AdaptedToolCall, NativeToolError,
};
pub use notebook::NotebookEditTool;
pub use patch::FilePatchTool;
pub use plan_mode::PlanModeTool;
pub use process::{ProcessKillTool, ProcessManager, ProcessOutputTool};
pub use router::{
    RegistrationError, RegistrationHandle, Tool, ToolCatalog, ToolContext, ToolError, ToolOrigin,
    ToolRouter,
};
pub use search::{FileGlobTool, FileGrepTool};
pub use shell::{ShellBatchTool, ShellRunTool};
pub use skill::SkillReadTool;
pub use tasks::{TaskCreateTool, TaskGetTool, TaskItemUpdateTool, TaskListTool, TaskManager};
pub use web::WebFetchTool;
pub use web_search::WebSearchTool;

/// Hosts that identify a tool call as network-bound for approval scoping.
pub use web::url_host;

/// Router with the full default toolset. Risk gating and approvals are
/// enforced per call by the executor, not by membership in this set.
pub fn default_router() -> ToolRouter {
    let router = ToolRouter::new();
    let tools: Vec<std::sync::Arc<dyn Tool>> = vec![
        std::sync::Arc::new(FileReadTool),
        std::sync::Arc::new(FileListTool),
        std::sync::Arc::new(FileWriteTool),
        std::sync::Arc::new(FileEditTool),
        std::sync::Arc::new(FileGlobTool),
        std::sync::Arc::new(FileGrepTool),
        std::sync::Arc::new(ShellRunTool),
        std::sync::Arc::new(ShellBatchTool),
        std::sync::Arc::new(GitStatusTool),
        std::sync::Arc::new(GitDiffTool),
        std::sync::Arc::new(WebFetchTool),
        std::sync::Arc::new(WebSearchTool),
        std::sync::Arc::new(SkillReadTool),
        std::sync::Arc::new(DocReadTool),
        std::sync::Arc::new(DocWriteTool),
        std::sync::Arc::new(TaskUpdateTool),
        std::sync::Arc::new(AskUserTool),
        std::sync::Arc::new(HttpRequestTool),
        std::sync::Arc::new(FilePatchTool),
        std::sync::Arc::new(ApplyPatchTool),
        std::sync::Arc::new(NotebookEditTool),
        std::sync::Arc::new(AgentRunTool),
        std::sync::Arc::new(AgentMessageTool),
        std::sync::Arc::new(PlanModeTool),
        std::sync::Arc::new(TaskCreateTool),
        std::sync::Arc::new(TaskGetTool),
        std::sync::Arc::new(TaskListTool),
        std::sync::Arc::new(TaskItemUpdateTool),
        std::sync::Arc::new(ProcessOutputTool),
        std::sync::Arc::new(ProcessKillTool),
        std::sync::Arc::new(MemorySearchTool),
        std::sync::Arc::new(MemoryWriteTool),
        std::sync::Arc::new(McpCallTool),
        std::sync::Arc::new(BrowserAutomationTool::default()),
    ];
    for tool in tools {
        router
            .register_builtin(tool)
            .expect("unique built-in tool name");
    }
    let catalog = router.catalog();
    router
        .register_builtin(std::sync::Arc::new(ToolSearchTool::new(catalog)))
        .expect("unique built-in tool name");
    router
}
