use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApiProtocol {
    #[default]
    Auto,
    ChatCompletions,
    Responses,
    AnthropicMessages,
}

impl ApiProtocol {
    pub fn parse(value: &str) -> Result<Self, String> {
        serde_json::from_value(serde_json::Value::String(value.trim().into()))
            .map_err(|_| format!("unsupported API protocol: {value}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

/// No credentials are stored in session preferences. Null model inherits the
/// daemon default; null effort preserves the provider's native behavior.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelSettings {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_protocol: ApiProtocol,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelUpdate {
    pub session_id: String,
    pub settings: SessionModelSettings,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceModelUpdate {
    pub workspace_id: String,
    pub settings: SessionModelSettings,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlobalModelUpdate {
    pub settings: SessionModelSettings,
}
