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
    /// Existing session to update alongside future-session defaults. Omit for a draft.
    #[serde(default)]
    pub session_id: Option<String>,
    pub settings: SessionModelSettings,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn global_model_update_accepts_existing_sessions_and_drafts() {
        for input in [
            json!({"settings":{}}),
            json!({"sessionId":null,"settings":{}}),
        ] {
            let update: GlobalModelUpdate = serde_json::from_value(input).unwrap();
            assert!(update.session_id.is_none());
        }
        let update: GlobalModelUpdate = serde_json::from_value(json!({
            "sessionId":"b", "settings":{"model":"chosen", "apiProtocol":"responses", "reasoningEffort":"high"}
        })).unwrap();
        assert_eq!(update.session_id.as_deref(), Some("b"));
        assert_eq!(
            update.settings.reasoning_effort,
            Some(ReasoningEffort::High)
        );
        assert!(serde_json::from_value::<GlobalModelUpdate>(json!({
            "sessionId":42,"settings":{}
        }))
        .is_err());
    }
}
