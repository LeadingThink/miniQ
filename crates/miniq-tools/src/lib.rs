//! miniq-tools: built-in tools and the ToolRouter.
//!
//! Tools expose their capability through the [`Tool`] trait and are invoked
//! exclusively through [`ToolRouter`], which validates input, evaluates risk
//! and dispatches. Approval and persistence are handled by the caller (the
//! daemon) around `dispatch`.

mod doc;
mod edit;
mod file;
mod git;
mod http;
mod interact;
mod mcp;
mod memory;
mod patch;
mod router;
mod search;
mod shell;
mod skill;
mod web;

pub use doc::{DocReadTool, DocWriteTool};
pub use edit::FileEditTool;
pub use file::{FileListTool, FileReadTool, FileWriteTool};
pub use git::{GitDiffTool, GitStatusTool};
pub use http::HttpRequestTool;
pub use interact::{AskUserTool, TaskUpdateTool};
pub use mcp::{McpBridge, McpCallTool};
pub use memory::{MemorySearchTool, MemoryWriteTool};
pub use patch::FilePatchTool;
pub use router::{Tool, ToolContext, ToolError, ToolRouter};
pub use search::{FileGlobTool, FileGrepTool};
pub use shell::ShellRunTool;
pub use skill::SkillReadTool;
pub use web::{SearchConfig, WebFetchTool, WebSearchTool};

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
    router.register(std::sync::Arc::new(MemorySearchTool));
    router.register(std::sync::Arc::new(MemoryWriteTool));
    router.register(std::sync::Arc::new(McpCallTool));
    router
}
