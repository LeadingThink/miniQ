use super::JsonInput;
use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum ApprovalCommand {
    /// One page of pending approvals; --before accepts the returned cursor as JSON.
    Inbox {
        #[arg(long)]
        before: Option<String>,
    },
    /// List all saved approval rules.
    Rules,
    /// Revoke a saved rule by ID.
    Revoke { rule: String },
    /// Resolve a pending approval explicitly.
    Resolve {
        approval_id: String,
        #[arg(value_parser = ["approve", "approve_for_session", "always_allow_tool", "reject"])]
        decision: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ReviewCommand {
    /// Review a completed assistant message using MODEL.
    Start {
        session: String,
        message: String,
        #[arg(value_name = "MODEL")]
        reviewer_model: String,
    },
    /// List a page of reviews and its nextCursor.
    List {
        session: String,
        #[arg(long)]
        message: Option<String>,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    Get {
        session: String,
        review: String,
    },
    Cancel {
        session: String,
        review: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ScheduleCommand {
    List,
    /// One page of executions for a task, with its continuation cursor.
    Runs {
        task: String,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    /// JSON: workspaceId, name, prompt, schedule; optional mode/targetSessionId/memory.
    #[command(
        after_help = "The daemon validates schedule expressions and heartbeat targets. Example:\n  miniq schedule create @schedule.json"
    )]
    Create(JsonInput),
    /// Replace task settings. JSON: id, name, prompt, schedule; optional workspaceId/mode/targetSessionId/memory.
    #[command(
        after_help = "Include mode and targetSessionId when updating a heartbeat task. Omitted mode/memory use daemon defaults; omitted workspaceId preserves the project."
    )]
    Update(JsonInput),
    Delete {
        task: String,
    },
    Enable {
        task: String,
    },
    Disable {
        task: String,
    },
    /// Run a saved task immediately.
    Run {
        task: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum MemoryCommand {
    /// JSON: target {scope: global|workspace, workspaceId?}, query?, before?, limit (1-100).
    #[command(
        after_help = "Example: miniq memory list '{\"target\":{\"scope\":\"global\"},\"limit\":20}'\nPass the returned nextCursor as before for subsequent pages."
    )]
    List(JsonInput),
    /// JSON: target, id, expectedUpdatedAt and expectedContent from the displayed record.
    Delete(JsonInput),
}

#[derive(Debug, Subcommand)]
pub enum ExternalCommand {
    /// Start a discovery job. Poll its ID with scan-status.
    Scan,
    ScanStatus {
        job: String,
    },
    /// JSON: sessions [{provider, externalId, sourcePath, workspaceId?}].
    Import(JsonInput),
    ImportStatus {
        job: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum WorkspaceCommand {
    List,
    /// Register an existing directory on the daemon computer.
    Open {
        path: String,
        #[arg(long)]
        name: Option<String>,
    },
    /// Create a new project directory in the daemon's projects directory.
    Create {
        name: String,
    },
    Rename {
        workspace: String,
        name: String,
    },
    /// Delete a project and its sessions according to the daemon's deletion rules.
    Delete {
        workspace: String,
    },
    /// JSON: workspaceId and paths. Changes require idle project tasks.
    Roots(JsonInput),
    ModelGet {
        workspace: String,
    },
    /// JSON: workspaceId, settings {model?, apiProtocol?, reasoningEffort?}.
    ModelSet(JsonInput),
}

#[derive(Debug, Subcommand)]
pub enum HostCommand {
    /// Saved and discovered SSH aliases from the daemon computer.
    List,
    /// Register an existing SSH configuration alias. Its SSH configuration stays authoritative.
    #[command(visible_aliases = ["add", "create"])]
    Save {
        host: String,
    },
    Remove {
        host: String,
    },
    Connect {
        host: String,
    },
    Disconnect {
        host: String,
    },
}
