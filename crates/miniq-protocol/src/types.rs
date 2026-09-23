//! Domain types shared by requests, responses and events.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A project with a primary directory and explicitly attached directories.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub additional_paths: Vec<String>,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRootsUpdate {
    pub workspace_id: String,
    /// Primary first, followed by the other authorized directories.
    #[schemars(length(min = 1))]
    pub paths: Vec<String>,
}

/// Session lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    WaitingApproval,
    Cancelling,
    Failed,
}

/// The active stage of an agent turn. This is intentionally descriptive,
/// not a synthetic percentage: model and tool runtimes are not predictable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
    PreparingContext,
    CompactingContext,
    RequestingModel,
    ReceivingModel,
    WaitingRetry,
    Finalizing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnProgress {
    pub phase: TurnPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_step: Option<usize>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<ModelRetryProgress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelRetryProgress {
    pub attempt: usize,
    pub max_attempts: usize,
    pub delay_ms: u64,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Running => "running",
            SessionStatus::WaitingApproval => "waiting_approval",
            SessionStatus::Cancelling => "cancelling",
            SessionStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub working_directory: String,
    pub title: String,
    pub status: SessionStatus,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<crate::ExternalSessionLink>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionGoalStatus {
    Active,
    Completed,
    Paused,
}

impl Default for SessionGoalStatus {
    fn default() -> Self {
        Self::Active
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoal {
    pub session_id: String,
    pub goal: String,
    pub status: SessionGoalStatus,
    pub token_budget: Option<u64>,
    pub used_tokens: u64,
    pub used_time_ms: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGoalUpdate {
    pub session_id: String,
    pub goal: String,
    #[serde(default)]
    pub status: SessionGoalStatus,
    pub token_budget: Option<u64>,
}

/// Create a new conversation from a durable assistant reply. The fork keeps
/// the source session untouched and copies only history up to the anchor.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionForkParams {
    pub session_id: String,
    pub anchor_message_id: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// A user message sent while the session had an active turn. Drained in
/// order when the turn ends, or steered to the front to interrupt.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub session_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachment>,
    pub position: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledTaskRunStatus {
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

impl ScheduledTaskRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskRun {
    pub id: String,
    pub task_id: String,
    pub session_id: Option<String>,
    pub status: ScheduledTaskRunStatus,
    pub reason: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub memory_before: String,
    pub memory_after: Option<String>,
    pub task_revision: i64,
}

/// A local file explicitly attached to a user message. Image MIME types are
/// sent to vision-capable models; other files remain available to the agent
/// through their absolute paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// How a recurring task is delivered. Existing tasks default to `newSession`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledTaskMode {
    NewSession,
    Heartbeat,
}

impl Default for ScheduledTaskMode {
    fn default() -> Self {
        Self::NewSession
    }
}

impl ScheduledTaskMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewSession => "newSession",
            Self::Heartbeat => "heartbeat",
        }
    }
}

/// A recurring task. A heartbeat appends the prompt to the selected existing
/// session, while a new-session task creates an isolated session each run.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub mode: ScheduledTaskMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_session_id: Option<String>,
    #[serde(default)]
    pub memory: String,
    /// Schedule spec as JSON (daily / weekly / weekdays / interval), parsed by the daemon.
    pub schedule: Value,
    pub enabled: bool,
    pub next_run_at: String,
    pub last_run_at: Option<String>,
    pub last_session_id: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub revision: i64,
}

/// Message author role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::Tool => "tool",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachment>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_timing: Option<crate::TurnTiming>,
}

/// Tool call lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    WaitingApproval,
    Running,
    Succeeded,
    Failed,
    Rejected,
    Cancelled,
}

impl ToolCallStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolCallStatus::Pending => "pending",
            ToolCallStatus::WaitingApproval => "waiting_approval",
            ToolCallStatus::Running => "running",
            ToolCallStatus::Succeeded => "succeeded",
            ToolCallStatus::Failed => "failed",
            ToolCallStatus::Rejected => "rejected",
            ToolCallStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub tool_name: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    pub status: ToolCallStatus,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

/// Risk level assigned by the sandbox to a tool invocation.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Blocked,
}

impl RiskLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            RiskLevel::Low => "low",
            RiskLevel::Medium => "medium",
            RiskLevel::High => "high",
            RiskLevel::Blocked => "blocked",
        }
    }
}

/// Approval request status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    ApprovedForSession,
    Rejected,
}

impl ApprovalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalStatus::Pending => "pending",
            ApprovalStatus::Approved => "approved",
            ApprovalStatus::ApprovedForSession => "approved_for_session",
            ApprovalStatus::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub risk_level: RiskLevel,
    pub status: ApprovalStatus,
    pub reason: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

/// One step in the agent's plan for the current task.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanTask {
    pub content: String,
    pub status: PlanTaskStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanTaskStatus {
    Pending,
    InProgress,
    Completed,
}

/// A clarification question the agent is waiting on.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// Suggested answers; the user can always type a free-form one.
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub option_descriptions: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub multi_select: bool,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_continue_after_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_answer: Option<String>,
}

/// A deliverable file produced during a task.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub session_id: String,
    /// Workspace-relative path.
    pub path: String,
    /// File kind, e.g. "docx", "xlsx", "md".
    pub kind: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub absolute_path: String,
    pub old_exists: bool,
    pub new_exists: bool,
    pub binary: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiff {
    pub files: Vec<FileDiff>,
    pub additions: usize,
    pub deletions: usize,
}

/// Daemon health snapshot returned by `daemon.health`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub protocol_version: u32,
    pub daemon_version: String,
    pub uptime_secs: u64,
}
