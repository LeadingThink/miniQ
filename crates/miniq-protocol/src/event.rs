//! Server-pushed events streamed from the daemon to connected UIs.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{
    Approval, Artifact, Message, PlanTask, Question, RiskLevel, SessionStatus, ToolCallStatus,
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
    /// This session's workflow looks worth saving as a skill.
    SkillSuggested {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
        #[serde(rename = "toolSequence")]
        tool_sequence: Vec<String>,
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
}

impl Event {
    pub fn session_id(&self) -> &str {
        match self {
            Event::SessionStatusChanged { session_id, .. }
            | Event::MessageCreated { session_id, .. }
            | Event::AssistantDelta { session_id, .. }
            | Event::ToolCallStarted { session_id, .. }
            | Event::ToolCallFinished { session_id, .. }
            | Event::ApprovalRequested { session_id, .. }
            | Event::ApprovalResolved { session_id, .. }
            | Event::PlanUpdated { session_id, .. }
            | Event::QuestionRequested { session_id, .. }
            | Event::QuestionResolved { session_id, .. }
            | Event::ArtifactCreated { session_id, .. }
            | Event::SkillSuggested { session_id, .. }
            | Event::TurnCompleted { session_id }
            | Event::TurnFailed { session_id, .. } => session_id,
        }
    }
}
