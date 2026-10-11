//! Poll-only second-opinion RPC types. No conversation events are added.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Stale,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    NoMaterialIssueFound,
    IssuesFound,
    InsufficientEvidence,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewSeverity {
    Suggestion,
    Important,
    Critical,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFinding {
    pub severity: ReviewSeverity,
    pub claim: String,
    pub evidence_ids: Vec<String>,
    pub recommendation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewEvidence {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRun {
    pub id: String,
    pub session_id: String,
    pub primary_message_id: String,
    pub model: String,
    pub status: ReviewStatus,
    pub verdict: Option<ReviewVerdict>,
    pub findings: Vec<ReviewFinding>,
    pub limitations: Vec<String>,
    pub evidence: Vec<ReviewEvidence>,
    pub error: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub created_at: String,
    pub completed_at: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewStartParams {
    pub session_id: String,
    pub primary_message_id: String,
    pub model: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewIdParams {
    pub session_id: String,
    pub review_id: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewListParams {
    pub session_id: String,
    pub primary_message_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: u32,
    pub cursor: Option<String>,
}
fn default_limit() -> u32 {
    50
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewListResult {
    pub runs: Vec<ReviewRun>,
    pub next_cursor: Option<String>,
}
