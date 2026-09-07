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

fn page_size<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let size = u32::deserialize(deserializer)?;
    if !(1..=100).contains(&size) {
        return Err(serde::de::Error::custom(
            "history limit must be between 1 and 100",
        ));
    }
    Ok(size)
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryParams {
    pub session_id: String,
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
}
