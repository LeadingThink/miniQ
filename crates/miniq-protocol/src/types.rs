//! Domain types shared by requests, responses and events.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A workspace is a local directory the agent is allowed to operate in.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub path: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
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
    pub title: String,
    pub status: SessionStatus,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<crate::ExternalSessionLink>,
    pub created_at: String,
    pub updated_at: String,
}

/// A recurring task: at each due time a fresh session is created in the
/// workspace and `prompt` is sent as the user message.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub prompt: String,
    /// Schedule spec as JSON (daily / weekly / interval), parsed by the daemon.
    pub schedule: Value,
    pub enabled: bool,
    pub next_run_at: String,
    pub last_run_at: Option<String>,
    pub last_session_id: Option<String>,
    pub created_at: String,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub media_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageAttachment>,
    pub created_at: String,
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
    /// Suggested answers; the user can always type a free-form one.
    #[serde(default)]
    pub options: Vec<String>,
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
