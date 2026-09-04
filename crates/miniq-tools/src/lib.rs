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
pub use router::{Tool, ToolContext, ToolError, ToolRouter};
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
    let mut router = ToolRouter::new();
    router.register(std::sync::Arc::new(FileReadTool));
    router.register(std::sync::Arc::new(FileListTool));
    router.register(std::sync::Arc::new(FileWriteTool));
    router.register(std::sync::Arc::new(FileEditTool));
    router.register(std::sync::Arc::new(FileGlobTool));
    router.register(std::sync::Arc::new(FileGrepTool));
    router.register(std::sync::Arc::new(ShellRunTool));
    router.register(std::sync::Arc::new(ShellBatchTool));
    router.register(std::sync::Arc::new(GitStatusTool));
    router.register(std::sync::Arc::new(GitDiffTool));
    router.register(std::sync::Arc::new(WebFetchTool));
    router.register(std::sync::Arc::new(WebSearchTool));
    router.register(std::sync::Arc::new(SkillReadTool));
    router.register(std::sync::Arc::new(DocReadTool));
    router.register(std::sync::Arc::new(DocWriteTool));
    router.register(std::sync::Arc::new(TaskUpdateTool));
    router.register(std::sync::Arc::new(AskUserTool));
    router.register(std::sync::Arc::new(HttpRequestTool));
    router.register(std::sync::Arc::new(FilePatchTool));
    router.register(std::sync::Arc::new(ApplyPatchTool));
    router.register(std::sync::Arc::new(NotebookEditTool));
    router.register(std::sync::Arc::new(AgentRunTool));
    router.register(std::sync::Arc::new(AgentMessageTool));
    router.register(std::sync::Arc::new(PlanModeTool));
    router.register(std::sync::Arc::new(TaskCreateTool));
    router.register(std::sync::Arc::new(TaskGetTool));
    router.register(std::sync::Arc::new(TaskListTool));
    router.register(std::sync::Arc::new(TaskItemUpdateTool));
    router.register(std::sync::Arc::new(ProcessOutputTool));
    router.register(std::sync::Arc::new(ProcessKillTool));
    router.register(std::sync::Arc::new(MemorySearchTool));
    router.register(std::sync::Arc::new(MemoryWriteTool));
    router.register(std::sync::Arc::new(McpCallTool));
    router.register(std::sync::Arc::new(BrowserAutomationTool::default()));
    let catalog = router.specs();
    router.register(std::sync::Arc::new(ToolSearchTool::new(catalog)));
    router
}
