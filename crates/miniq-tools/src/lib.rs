//! miniq-tools: built-in tools and the ToolRouter.
//!
//! Tools expose their capability through the [`Tool`] trait and are invoked
//! exclusively through [`ToolRouter`], which validates input, evaluates risk
//! and dispatches. Approval and persistence are handled by the caller (the
//! daemon) around `dispatch`.

mod file;
mod git;
mod router;
mod shell;

pub use file::{FileListTool, FileReadTool, FileWriteTool};
pub use git::{GitDiffTool, GitStatusTool};
pub use router::{Tool, ToolContext, ToolError, ToolRouter};
pub use shell::ShellRunTool;

/// Router with the default read-only toolset (Phase 2).
pub fn default_readonly_router() -> ToolRouter {
    let mut router = ToolRouter::new();
    router.register(std::sync::Arc::new(FileReadTool));
    router.register(std::sync::Arc::new(FileListTool));
    router.register(std::sync::Arc::new(ShellRunTool));
    router.register(std::sync::Arc::new(GitStatusTool));
    router.register(std::sync::Arc::new(GitDiffTool));
    router
}

/// Router with the full toolset including write tools (requires approvals).
pub fn default_router() -> ToolRouter {
    let mut router = default_readonly_router();
    router.register(std::sync::Arc::new(FileWriteTool));
    router
}
