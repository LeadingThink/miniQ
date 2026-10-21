//! Typed terminal controls for the shared daemon's session and task APIs.

use clap::{Args, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct SessionTarget {
    #[arg(value_name = "SESSION_ID")]
    pub session: String,
    /// Print the original daemon response as JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct SessionPage {
    #[arg(value_name = "SESSION_ID")]
    pub session: String,
    /// Records in this page. Continue with the returned nextCursor.
    #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
    pub limit: u32,
    /// JSON nextCursor from the previous page.
    #[arg(long, value_name = "CURSOR")]
    pub before: Option<String>,
    #[arg(long)]
    pub agent: Option<String>,
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum SessionCommand {
    /// Pause an active turn without discarding its queued messages.
    Pause(SessionTarget),
    /// Resume a paused turn, including a persisted pause after daemon restart.
    Resume(SessionTarget),
    /// Read, set or control a session's persistent goal.
    Goal {
        #[command(subcommand)]
        command: GoalCommand,
    },
    /// Replace a user message and rerun from it. Existing attachments are preserved.
    Rewrite {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        #[arg(value_name = "MESSAGE_ID")]
        message: String,
        /// New message text, or - to read UTF-8 text from stdin.
        content: String,
        /// Replace the attachment list with these local files (repeatable).
        #[arg(
            long = "attach",
            value_name = "FILE",
            conflicts_with = "clear_attachments"
        )]
        attachments: Vec<PathBuf>,
        /// Explicitly remove all attachments from the edited message.
        #[arg(long)]
        clear_attachments: bool,
        #[arg(long)]
        json: bool,
    },
    /// Restore files changed by a turn to their content at its start.
    RevertTurn {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        /// User message that started the turn.
        #[arg(value_name = "TURN_ID")]
        turn: String,
        /// Also overwrite edits made after that turn ended.
        #[arg(long)]
        force: bool,
        #[arg(long)]
        json: bool,
    },
    /// Clear a failure badge only if it still matches the observed update time.
    #[command(visible_alias = "ack")]
    AcknowledgeFailure {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        /// Exact updatedAt from the failed session; prevents clearing a newer failure.
        #[arg(long)]
        updated_at: String,
        #[arg(long)]
        json: bool,
    },
    /// Find the latest matching message per session (at most --limit matches).
    Search {
        query: String,
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    /// Pin a session, or unpin it with --off.
    Pin {
        #[command(flatten)]
        target: SessionTarget,
        #[arg(long)]
        off: bool,
    },
    /// Archive a session, or restore it with --off.
    Archive {
        #[command(flatten)]
        target: SessionTarget,
        #[arg(long)]
        off: bool,
    },
    /// Delete a session and its retained history. Requires --yes.
    Delete {
        #[command(flatten)]
        target: SessionTarget,
        #[arg(long, required = true)]
        yes: bool,
    },
    /// Publish explicitly selected messages, list links or revoke a link.
    Share {
        #[command(subcommand)]
        command: ShareCommand,
    },
    /// Read a page of durable execution events, including failure reasons.
    Events(SessionPage),
    /// Read a page of provider requests, usage, retries and timing.
    ModelCalls(SessionPage),
    /// Read one page of the folded work of a turn; tool payloads use tool-detail.
    Process {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        /// Opening user message; omit for records before the first user message.
        #[arg(long)]
        turn: Option<String>,
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, value_name = "CURSOR")]
        before: Option<String>,
        #[arg(long)]
        include_internal: bool,
        #[arg(long)]
        json: bool,
    },
    /// Read complete input and output for one tool call in this session.
    ToolDetail {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        #[arg(value_name = "TOOL_CALL_ID")]
        tool: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum GoalCommand {
    /// Read goal text, state and accumulated usage.
    Get(SessionTarget),
    /// Set goal text. This does not submit a task or silently change its state.
    Set {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        goal: String,
        /// Set a positive token budget; otherwise preserve the saved budget.
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
        token_budget: Option<u64>,
        #[arg(long, conflicts_with = "token_budget")]
        clear_token_budget: bool,
        #[arg(long)]
        json: bool,
    },
    /// Pause, resume, cancel or mark a goal complete, controlling its turn too.
    Status {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        #[arg(value_enum)]
        status: GoalStatus,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum GoalStatus {
    Active,
    Paused,
    Cancelled,
    Completed,
}

#[derive(Subcommand, Debug)]
pub enum ShareCommand {
    /// Publish only selected messages/files to a public link.
    Create {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        /// Unique 32-character lowercase hexadecimal ID. Reuse after an unknown outcome.
        #[arg(long, value_parser = share_id)]
        id: String,
        #[arg(long)]
        title: String,
        /// Message to include (repeatable; obtain IDs with miniq history).
        #[arg(long = "message", required = true)]
        messages: Vec<String>,
        /// Artifact to include (repeatable, at most 30; omitted files remain private).
        #[arg(long = "artifact")]
        artifacts: Vec<String>,
        #[arg(long, default_value = "7", value_parser = ["7", "30", "90"])]
        days: String,
        #[arg(long)]
        include_details: bool,
        #[arg(long)]
        json: bool,
    },
    List {
        #[command(flatten)]
        target: SessionTarget,
        /// nextCursor returned by the previous page.
        #[arg(long, value_parser = share_id)]
        after: Option<String>,
    },
    Revoke {
        #[command(flatten)]
        target: SessionTarget,
        #[arg(value_name = "SHARE_ID", value_parser = share_id)]
        id: String,
    },
}

fn share_id(value: &str) -> Result<String, String> {
    if value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(value.to_owned())
    } else {
        Err("share ID must contain exactly 32 lowercase hexadecimal characters".into())
    }
}

#[derive(Subcommand, Debug)]
pub enum QueueCommand {
    /// List the complete queued messages and their attachments.
    List(SessionTarget),
    /// Edit only message text; keep attachments and use an atomic content check.
    Update {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        #[arg(value_name = "QUEUED_MESSAGE_ID")]
        id: String,
        /// New text, or - to read from stdin.
        content: String,
        #[arg(long)]
        json: bool,
    },
    /// Move a queued message one place using its observed position.
    Move {
        #[arg(value_name = "SESSION_ID")]
        session: String,
        #[arg(value_name = "QUEUED_MESSAGE_ID")]
        id: String,
        #[arg(value_enum)]
        direction: QueueDirection,
        #[arg(long)]
        json: bool,
    },
    /// Remove one queued message after checking that it belongs to this session.
    Remove(QueueTarget),
    /// Promote one queued message and interrupt the current turn.
    Steer(QueueTarget),
}

#[derive(Args, Debug)]
pub struct QueueTarget {
    #[arg(value_name = "SESSION_ID")]
    pub session: String,
    #[arg(value_name = "QUEUED_MESSAGE_ID")]
    pub id: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum QueueDirection {
    Up,
    Down,
}

#[derive(Args, Debug)]
pub struct AgentTarget {
    #[arg(value_name = "SESSION_ID")]
    pub session: String,
    #[arg(value_name = "AGENT_ID")]
    pub agent: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum AgentCommand {
    /// List this session's child agents, including their retained state.
    List(SessionTarget),
    /// Read the latest retained output without waiting or restarting the agent.
    Output(AgentTarget),
    /// Page through a child agent's conversation index.
    History {
        #[command(flatten)]
        target: AgentTarget,
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        /// JSON nextCursor from the preceding agent history page.
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Read one complete historical message; this does not send a new message.
    Message {
        #[command(flatten)]
        target: AgentTarget,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        index: u32,
    },
    /// Stop this session's child agent.
    Stop(AgentTarget),
}
