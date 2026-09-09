use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{HistoryCursor, ModelCallsParams, TurnProgress};

pub type ExecutionEventsParams = ModelCallsParams;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExecutionEventData {
    ModelRetry {
        agent_id: Option<String>,
        progress: TurnProgress,
    },
    ContextCompacted {
        agent_id: Option<String>,
        turn_id: String,
        estimated_tokens_before: usize,
        estimated_tokens_after: usize,
    },
    QueuedMessageStarted {
        source_message_id: String,
        queued_message_id: String,
        queued_at: String,
    },
    TurnOutcome {
        anchor_message_id: String,
        status: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEventRecord {
    pub id: String,
    pub session_id: String,
    pub created_at: String,
    #[serde(flatten)]
    pub event: ExecutionEventData,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEventsPage {
    pub events: Vec<ExecutionEventRecord>,
    pub next_cursor: Option<HistoryCursor>,
}
