use std::sync::Arc;

use miniq_models::{ConfiguredProvider, ModelProvider, ProviderConfig};
use miniq_protocol::{ApiProtocol, SessionModelSettings};
use sha2::{Digest, Sha256};

use crate::state::AppState;

pub(crate) fn apply_selection(config: &mut ProviderConfig, selection: &SessionModelSettings) {
    if let Some(model) = &selection.model {
        config.model = model.clone();
        config.api_protocol = selection.api_protocol;
    } else if selection.api_protocol != ApiProtocol::Auto {
        config.api_protocol = selection.api_protocol;
    }
    // Default effort means provider default, not another session's/global effort.
    config.reasoning_effort = selection.reasoning_effort;
}

impl AppState {
    pub(crate) fn provider_config_for_session(
        &self,
        session_id: &str,
        model: Option<&str>,
    ) -> Result<Option<ProviderConfig>, miniq_memory::MemoryError> {
        let selection = self.store.session_model_settings(session_id)?;
        let Some(mut config) = self.settings.lock().unwrap().provider.clone() else {
            return Ok(None);
        };
        apply_selection(&mut config, &selection);
        if let Some(model) = model {
            if config.model != model {
                config.model = model.to_owned();
                config.api_protocol = ApiProtocol::Auto;
                config.reasoning_effort = None;
            }
        }
        Ok(Some(config))
    }

    pub(crate) fn provider_from_config(
        &self,
        config: Option<ProviderConfig>,
    ) -> Arc<dyn ModelProvider> {
        if let Some(provider) = &self.provider_override {
            return provider.clone();
        }
        match config {
            Some(config) => Arc::new(ConfiguredProvider::new(config)),
            None => Arc::new(crate::UnconfiguredProvider),
        }
    }
}

pub(crate) fn model_identity(config: Option<&ProviderConfig>) -> Option<String> {
    config.map(|config| {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::json!([
                    config.base_url,
                    config.api_key,
                    config.model,
                    config.api_protocol
                ])
                .to_string()
            )
        )
    })
}

pub(crate) fn isolate_native_context(
    history: &mut [miniq_models::ChatMessage],
    previous: Option<&str>,
    current: Option<&str>,
) {
    if previous.is_some() && previous == current {
        return;
    }
    for message in history {
        message.provider_context = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::ReasoningEffort;

    #[test]
    fn explicit_model_does_not_inherit_a_different_models_protocol_or_effort() {
        let mut config = ProviderConfig {
            base_url: "https://test/v1".into(),
            api_key: "secret".into(),
            model: "gpt-5.6-sol".into(),
            api_protocol: ApiProtocol::Responses,
            reasoning_effort: Some(ReasoningEffort::High),
        };
        apply_selection(
            &mut config,
            &SessionModelSettings {
                model: Some("claude-sonnet-4.6".into()),
                ..Default::default()
            },
        );
        assert_eq!(config.model, "claude-sonnet-4.6");
        assert_eq!(config.api_protocol, ApiProtocol::Auto);
        assert_eq!(config.reasoning_effort, None);
        assert_eq!(config.api_key, "secret");
        assert!(!model_identity(Some(&config)).unwrap().contains("secret"));
    }

    #[test]
    fn model_switch_drops_only_private_context_and_identity_never_stores_url_secrets() {
        use miniq_models::{ChatMessage, ProviderContext, ToolCallRequest};
        let mut answer = ChatMessage::assistant("visible evidence");
        answer.tool_calls.push(ToolCallRequest {
            id: "call".into(),
            name: "file_read".into(),
            arguments: serde_json::json!({"path":"README.md"}),
        });
        answer.provider_context = Some(ProviderContext {
            protocol: ApiProtocol::Responses,
            data: serde_json::json!({"encrypted":"private"}),
        });
        let mut history = vec![answer, ChatMessage::tool_result("call", "file evidence")];
        isolate_native_context(&mut history, Some("same"), Some("same"));
        assert!(history[0].provider_context.is_some());
        isolate_native_context(&mut history, Some("old"), Some("new"));
        assert!(history[0].provider_context.is_none());
        assert_eq!(history[0].content, "visible evidence");
        assert_eq!(history[0].tool_calls[0].id, "call");
        assert_eq!(history[1].content, "file evidence");
        let config = ProviderConfig {
            base_url: "https://user:password@test/v1?key=secret".into(),
            api_key: "private".into(),
            model: "custom".into(),
            api_protocol: ApiProtocol::Auto,
            reasoning_effort: None,
        };
        let identity = model_identity(Some(&config)).unwrap();
        assert_eq!(identity.len(), 64);
        assert!(!identity.contains("secret"));
        let mut rotated = config.clone();
        rotated.api_key = "different-account".into();
        assert_ne!(model_identity(Some(&rotated)), Some(identity));
    }
}
