use crate::{Approval, HistoryCursor};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalInboxParams {
    #[serde(default)]
    pub before: Option<HistoryCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalInboxEntry {
    pub approval: Approval,
    pub session_title: String,
    pub tool_name: String,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalInboxPage {
    pub entries: Vec<ApprovalInboxEntry>,
    pub next_cursor: Option<HistoryCursor>,
}
