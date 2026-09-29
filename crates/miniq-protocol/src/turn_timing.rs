use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnTimingStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

/// One execution of a user request. Phase changes and model retries do not
/// restart this clock. Missing elapsed time means it could not be measured,
/// for example after an unclean daemon restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnTiming {
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    pub status: TurnTimingStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageTurnTiming {
    pub message_id: String,
    pub timing: TurnTiming,
}

/// Terminal outcome reported in [`TurnSummary`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnSummaryStatus {
    Completed,
    Failed,
    Cancelled,
}

/// Aggregate facts about one finished turn, attached to the terminal turn
/// event. Tool calls and file changes cover everything recorded for the
/// session since the turn clock started, including sub-agent calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    pub status: TurnSummaryStatus,
    pub tool_calls: u32,
    pub failed_tool_calls: u32,
    /// Distinct file paths checkpointed by write tools during the turn.
    pub files_changed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}
