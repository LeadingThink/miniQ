use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Message, ToolCall};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCursor {
    pub at: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HistoryFilter {
    #[default]
    All,
    Answers,
    Activity,
    Errors,
}

impl HistoryFilter {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Answers => "answers",
            Self::Activity => "activity",
            Self::Errors => "errors",
        }
    }
}

fn default_page_size() -> u32 {
    40
}

fn default_process_page_size() -> u32 {
    100
}

fn page_size<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let size = u32::deserialize(deserializer)?;
    if !(1..=100).contains(&size) {
        return Err(serde::de::Error::custom(
            "history limit must be between 1 and 100",
        ));
    }
    Ok(size)
}

/// How `session.history` / `session.open` count and group a page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HistoryView {
    /// Raw timeline rows: messages and tool calls, filtered by `filter`/`query`.
    #[default]
    Raw,
    /// What the conversation shows outside folded work: `limit` counts visible
    /// messages, pages end on a turn boundary, and the folded process of each
    /// returned turn is summarised in `processSummaries` instead of returned.
    /// Requires the default filter, an empty query and no agent/tool filter.
    Visible,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryParams {
    pub session_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub before: Option<HistoryCursor>,
    #[serde(default = "default_page_size", deserialize_with = "page_size")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
    #[serde(default)]
    pub filter: HistoryFilter,
    #[serde(default)]
    pub query: String,
    /// Export reads the same paged history with complete tool payloads.
    #[serde(default)]
    pub include_payloads: bool,
    #[serde(default)]
    pub include_internal: bool,
    #[serde(default)]
    pub view: HistoryView,
    /// Raw view only: keep tool calls with exactly this tool name and no messages.
    #[serde(default)]
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryToolCall {
    #[serde(flatten)]
    pub call: ToolCall,
    pub payload_deferred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub messages: Vec<Message>,
    pub tool_calls: Vec<HistoryToolCall>,
    pub next_cursor: Option<HistoryCursor>,
    /// Visible view only: one summary per turn on the page, newest last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub process_summaries: Vec<ProcessSummary>,
}

/// The folded work of one turn, without any of its records. A turn is the
/// non-steered user message that opened it and everything up to the next one;
/// `turnId` is that message's id, or absent for rows before the first user message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Tool calls plus folded messages (commentary, steering, tool transcripts).
    pub record_count: u32,
    pub tool_call_count: u32,
    pub message_count: u32,
    /// Tool calls per status, e.g. `{"succeeded": 40, "failed": 2}`.
    pub status_counts: std::collections::BTreeMap<String, u32>,
    /// Tool calls that checkpoint files before writing.
    pub file_write_count: u32,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
}

/// Folded records of one turn, newest first, in pages. Payloads stay on `tool.detail`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRecordsParams {
    pub session_id: String,
    /// Opening user message of the turn; absent for rows before the first one.
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub before: Option<HistoryCursor>,
    #[serde(default = "default_process_page_size", deserialize_with = "page_size")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
    #[serde(default)]
    pub include_internal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolDetailParams {
    pub session_id: String,
    pub tool_call_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_limits_match_schema_and_defaults() {
        let input: HistoryParams = serde_json::from_value(json!({"sessionId":"s"})).unwrap();
        assert_eq!(input.limit, 40);
        for invalid in [json!(0), json!(101), json!(-1), json!(1.5), json!("40")] {
            assert!(serde_json::from_value::<HistoryParams>(
                json!({"sessionId":"s","limit":invalid})
            )
            .is_err());
        }
        let schema = serde_json::to_value(schemars::schema_for!(HistoryParams)).unwrap();
        assert_eq!(schema["properties"]["limit"]["minimum"].as_f64(), Some(1.0));
        assert_eq!(
            schema["properties"]["limit"]["maximum"].as_f64(),
            Some(100.0)
        );
        assert_eq!(schema["properties"]["limit"]["default"], 40);
    }

    #[test]
    fn visible_view_and_process_records_are_strict() {
        let input: HistoryParams = serde_json::from_value(json!({"sessionId":"s"})).unwrap();
        assert_eq!(input.view, HistoryView::Raw);
        let input: HistoryParams =
            serde_json::from_value(json!({"sessionId":"s","view":"visible"})).unwrap();
        assert_eq!(input.view, HistoryView::Visible);
        assert!(
            serde_json::from_value::<HistoryParams>(json!({"sessionId":"s","view":"folded"}))
                .is_err()
        );
        let records: ProcessRecordsParams =
            serde_json::from_value(json!({"sessionId":"s","turnId":"m"})).unwrap();
        assert_eq!(records.limit, 100);
        for invalid in [json!(0), json!(101)] {
            assert!(serde_json::from_value::<ProcessRecordsParams>(
                json!({"sessionId":"s","limit":invalid})
            )
            .is_err());
        }
        assert!(serde_json::from_value::<ProcessRecordsParams>(
            json!({"sessionId":"s","surprise":1})
        )
        .is_err());
    }
}
