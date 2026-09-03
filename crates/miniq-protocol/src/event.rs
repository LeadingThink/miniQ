//! Server-pushed events streamed from the daemon to connected UIs.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{
    Approval, Artifact, Message, PlanTask, Question, RiskLevel, SessionStatus, ToolCallStatus,
    TurnProgress,
};

/// An event pushed by the daemon over the WebSocket connection.
///
/// Events are distinguished from RPC responses by the presence of a `type`
/// field instead of `id`/`result`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Session status changed (idle/running/waiting_approval/...).
    SessionStatusChanged {
        #[serde(rename = "sessionId")]
        session_id: String,
        status: SessionStatus,
    },
    /// The current observable stage of a running turn changed.
    TurnProgressChanged {
        #[serde(rename = "sessionId")]
        session_id: String,
        progress: TurnProgress,
    },
    /// A full message was persisted (user echo or final assistant message).
    MessageCreated {
        #[serde(rename = "sessionId")]
        session_id: String,
        message: Message,
    },
    /// Incremental assistant output token(s) for the current turn.
    AssistantDelta {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        delta: String,
    },
    /// Old context was summarized or oversized tool results were pruned.
    ContextCompacted {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "estimatedTokensBefore")]
        estimated_tokens_before: usize,
        #[serde(rename = "estimatedTokensAfter")]
        estimated_tokens_after: usize,
    },
    /// A tool call started executing.
    ToolCallStarted {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        input: Value,
    },
    /// A tool call finished (succeeded/failed/rejected/cancelled).
    ToolCallFinished {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        status: ToolCallStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Value>,
    },
    /// The daemon is waiting for the user to resolve an approval.
    ApprovalRequested {
        #[serde(rename = "sessionId")]
        session_id: String,
        approval: Approval,
        #[serde(rename = "toolName")]
        tool_name: String,
        input: Value,
        #[serde(rename = "riskLevel")]
        risk_level: RiskLevel,
    },
    /// An approval was resolved (by the user or by policy).
    ApprovalResolved {
        #[serde(rename = "sessionId")]
        session_id: String,
        approval: Approval,
    },
    /// The agent updated its step plan for the current task.
    PlanUpdated {
        #[serde(rename = "sessionId")]
        session_id: String,
        tasks: Vec<PlanTask>,
    },
    /// The agent is waiting for the user to answer a question.
    QuestionRequested {
        #[serde(rename = "sessionId")]
        session_id: String,
        question: Question,
    },
    /// A question was answered.
    QuestionResolved {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "questionId")]
        question_id: String,
        answer: String,
    },
    /// A deliverable file was produced.
    ArtifactCreated {
        #[serde(rename = "sessionId")]
        session_id: String,
        artifact: Artifact,
    },
    /// The current turn finished (final assistant message already sent via
    /// `MessageCreated`).
    TurnCompleted {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// The current turn failed with an error message.
    TurnFailed {
        #[serde(rename = "sessionId")]
        session_id: String,
        error: String,
    },
    /// A session was deleted.
    SessionDeleted {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// A workspace (project) was deleted.
    WorkspaceDeleted {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    /// A session was renamed.
    SessionRenamed {
        #[serde(rename = "sessionId")]
        session_id: String,
        title: String,
    },
    /// A workspace was renamed.
    WorkspaceRenamed {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        name: String,
    },
    /// A session's pinned state changed.
    SessionPinnedChanged {
        #[serde(rename = "sessionId")]
        session_id: String,
        pinned: bool,
    },
    /// A session's archived state changed.
    SessionArchivedChanged {
        #[serde(rename = "sessionId")]
        session_id: String,
        archived: bool,
    },
    /// The session's queued (not yet executed) user messages changed.
    QueueChanged {
        #[serde(rename = "sessionId")]
        session_id: String,
        queue: Vec<crate::types::QueuedMessage>,
    },
}

impl Event {
    pub fn session_id(&self) -> &str {
        match self {
            Event::SessionStatusChanged { session_id, .. }
            | Event::TurnProgressChanged { session_id, .. }
            | Event::MessageCreated { session_id, .. }
            | Event::AssistantDelta { session_id, .. }
            | Event::ContextCompacted { session_id, .. }
            | Event::ToolCallStarted { session_id, .. }
            | Event::ToolCallFinished { session_id, .. }
            | Event::ApprovalRequested { session_id, .. }
            | Event::ApprovalResolved { session_id, .. }
            | Event::PlanUpdated { session_id, .. }
            | Event::QuestionRequested { session_id, .. }
            | Event::QuestionResolved { session_id, .. }
            | Event::ArtifactCreated { session_id, .. }
            | Event::TurnCompleted { session_id }
            | Event::TurnFailed { session_id, .. }
            | Event::SessionDeleted { session_id }
            | Event::SessionRenamed { session_id, .. }
            | Event::SessionPinnedChanged { session_id, .. }
            | Event::SessionArchivedChanged { session_id, .. }
            | Event::QueueChanged { session_id, .. } => session_id,
            Event::WorkspaceDeleted { .. } | Event::WorkspaceRenamed { .. } => "",
        }
    }
}
