use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHistoryCursor {
    pub revision: u64,
    pub before: u32,
}

fn default_limit() -> u32 {
    20
}
fn page_limit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let limit = u32::deserialize(deserializer)?;
    if !(1..=100).contains(&limit) {
        return Err(serde::de::Error::custom("limit must be between 1 and 100"));
    }
    Ok(limit)
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHistoryParams {
    pub session_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub cursor: Option<AgentHistoryCursor>,
    #[serde(default = "default_limit", deserialize_with = "page_limit")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageParams {
    pub session_id: String,
    pub agent_id: String,
    pub revision: u64,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryEntry {
    pub index: u32,
    pub role: String,
    pub text_characters: u64,
    pub tool_count: u32,
    pub image_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryPage {
    pub revision: u64,
    pub entries: Vec<AgentHistoryEntry>,
    pub next_cursor: Option<AgentHistoryCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryMessage {
    pub message: Value,
}
