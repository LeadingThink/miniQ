//! Provider-neutral contracts for discovering and importing external sessions.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Role;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalProvider {
    Codex,
    ClaudeCode,
    #[serde(rename = "opencode")]
    OpenCode,
}

impl ExternalProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude_code",
            Self::OpenCode => "opencode",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalContinuationMode {
    NativeResumable,
    RecreateOnly,
    ReadOnly,
}

impl ExternalContinuationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeResumable => "native_resumable",
            Self::RecreateOnly => "recreate_only",
            Self::ReadOnly => "read_only",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionSummary {
    pub provider: ExternalProvider,
    pub external_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub source_path: String,
    pub message_count: usize,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub continuation_mode: ExternalContinuationMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProviderStatus {
    pub provider: ExternalProvider,
    pub root: String,
    pub available: bool,
    pub session_count: usize,
    pub message_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalScanError {
    pub provider: ExternalProvider,
    pub source_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionScan {
    pub providers: Vec<ExternalProviderStatus>,
    pub sessions: Vec<ExternalSessionSummary>,
    pub errors: Vec<ExternalScanError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionSelection {
    pub provider: ExternalProvider,
    pub external_id: String,
    pub source_path: String,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionImportRequest {
    #[schemars(length(min = 1))]
    pub sessions: Vec<ExternalSessionSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportError {
    pub provider: ExternalProvider,
    pub external_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionImportResult {
    pub imported_session_ids: Vec<String>,
    pub imported_messages: usize,
    pub errors: Vec<ExternalImportError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionLink {
    pub provider: ExternalProvider,
    pub external_id: String,
    pub source_path: String,
    pub continuation_mode: ExternalContinuationMode,
    pub imported_at: String,
    pub last_synced_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionEvent {
    pub event_id: String,
    pub sequence: usize,
    pub event_type: String,
    pub payload: Value,
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionMessage {
    pub event_id: String,
    pub role: Role,
    pub content: String,
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionSnapshot {
    pub summary: ExternalSessionSummary,
    pub events: Vec<ExternalSessionEvent>,
    pub messages: Vec<ExternalSessionMessage>,
}

#[cfg(test)]
mod tests {
    use super::{ExternalProvider, ExternalSessionImportRequest};

    #[test]
    fn opencode_wire_value_matches_provider_id() {
        let encoded = serde_json::to_string(&ExternalProvider::OpenCode).unwrap();
        assert_eq!(encoded, "\"opencode\"");
        let decoded: ExternalProvider = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, ExternalProvider::OpenCode);
    }

    #[test]
    fn import_request_schema_requires_a_selection() {
        let schema =
            serde_json::to_value(schemars::schema_for!(ExternalSessionImportRequest)).unwrap();
        assert_eq!(schema["properties"]["sessions"]["minItems"], 1);
    }
}
