//! Cohesive commands for daemon capabilities shared with desktop and mobile.
mod code;
mod extensions;
mod management;

use clap::{Args, Subcommand};
pub use code::*;
pub use extensions::*;
pub use management::*;

#[derive(Debug, Args)]
pub struct JsonInput {
    /// Parameters as inline JSON, - for stdin, or @FILE. Daemon paths refer to its computer.
    #[arg(value_name = "JSON|-|@FILE")]
    pub input: String,
}

#[derive(Debug, Subcommand)]
pub enum DomainCommand {
    /// Inspect the repository used by a session.
    Git {
        #[command(subcommand)]
        command: GitCommand,
    },
    /// Create and operate a daemon-owned PTY without starting an agent task.
    Terminal {
        #[command(subcommand)]
        command: TerminalCommand,
    },
    /// Browse and read session-accessible files; pages/chunks retain their continuation metadata.
    File {
        #[command(subcommand)]
        command: FileCommand,
    },
    /// List agent tools or inspect a recorded tool call.
    Tool {
        #[command(subcommand)]
        command: ToolCommand,
    },
    /// Pending approvals and saved approval rules.
    Approval {
        #[command(subcommand)]
        command: ApprovalCommand,
    },
    /// Request and inspect a second opinion on a completed answer.
    Review {
        #[command(subcommand)]
        command: ReviewCommand,
    },
    /// Create and manage scheduled or heartbeat tasks.
    Schedule {
        #[command(subcommand)]
        command: ScheduleCommand,
    },
    /// Manage exact project or global memory scopes.
    Memory {
        #[command(subcommand)]
        command: MemoryCommand,
    },
    /// Discover and import conversations from external assistants.
    External {
        #[command(subcommand)]
        command: ExternalCommand,
    },
    /// Manage projects, their roots, and their default model.
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    /// Manage SSH aliases from the daemon computer's SSH configuration.
    #[command(visible_alias = "ssh")]
    Host {
        #[command(subcommand)]
        command: HostCommand,
    },
    /// Voice models, transcription and speech synthesis.
    Voice {
        #[command(subcommand)]
        command: VoiceCommand,
    },
    /// Inspect or request native computer-control permissions on the daemon computer.
    Computer {
        #[command(subcommand)]
        command: ComputerCommand,
    },
}
