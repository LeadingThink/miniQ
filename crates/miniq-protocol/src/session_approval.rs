use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    AlwaysAsk,
    #[default]
    Auto,
    FullAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionApprovalUpdate {
    pub session_id: String,
    pub mode: Option<ApprovalMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionApprovalSettings {
    pub mode: Option<ApprovalMode>,
    pub effective: ApprovalMode,
}
