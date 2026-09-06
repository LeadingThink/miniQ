//! Model-specific effort choices. Unknown families keep provider defaults.
use miniq_protocol::ReasoningEffort;
use serde_json::{json, Value};

use crate::{ApiProtocol, ProviderConfig};

pub fn reasoning_efforts(model: &str, protocol: ApiProtocol) -> Vec<ReasoningEffort> {
    use ReasoningEffort::*;
    let name = model.to_ascii_lowercase().replace('.', "-");
    // Specialized GPT variants have their own effort contracts. Use advertised
    // capabilities for those IDs instead of inheriting the base family list.
    if name.starts_with("gpt-") && (name.contains("-pro") || name.contains("-codex")) {
        return Vec::new();
    }
    if name.starts_with("deepseek-v4-") {
        return vec![None, Low, High, Max];
    }
    if protocol == ApiProtocol::ChatCompletions && name.starts_with("gemini-") {
        return if name.starts_with("gemini-3") {
            if name.contains("pro") {
                vec![Low, Medium, High]
            } else {
                vec![Minimal, Low, Medium, High]
            }
        } else if name.starts_with("gemini-2-5") {
            if name.contains("pro") {
                vec![Minimal, Low, Medium, High]
            } else {
                vec![None, Minimal, Low, Medium, High]
            }
        } else {
            Vec::new()
        };
    }
    match protocol {
        ApiProtocol::Responses | ApiProtocol::ChatCompletions => {
            if name.starts_with("gpt-6-") || name.starts_with("gpt-5-6") {
                vec![Low, Medium, High, Xhigh, Max]
            } else if name.starts_with("gpt-5-2")
                || name.starts_with("gpt-5-4")
                || name.starts_with("gpt-5-5")
            {
                vec![None, Low, Medium, High, Xhigh]
            } else if name.starts_with("gpt-5-1") {
                vec![None, Low, Medium, High]
            } else if name == "gpt-5"
                || name.starts_with("gpt-5-mini")
                || name.starts_with("gpt-5-nano")
            {
                vec![Minimal, Low, Medium, High]
            } else if name.starts_with("o3") || name.starts_with("o4-mini") {
                vec![Low, Medium, High]
            } else {
                Vec::new()
            }
        }
        ApiProtocol::AnthropicMessages => {
            if [
                "claude-opus-5",
                "claude-opus-4-7",
                "claude-opus-4-8",
                "claude-sonnet-5",
                "claude-fable-5",
                "claude-mythos-5",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
            {
                vec![Low, Medium, High, Xhigh, Max]
            } else if name.starts_with("claude-opus-4-6") || name.starts_with("claude-sonnet-4-6") {
                vec![Low, Medium, High, Max]
            } else if name.starts_with("claude-opus-4-5") {
                vec![Low, Medium, High]
            } else {
                Vec::new()
            }
        }
        ApiProtocol::Auto => Vec::new(),
    }
}

pub(crate) fn apply_reasoning(body: &mut Value, config: &ProviderConfig, protocol: ApiProtocol) {
    let Some(effort) = config.reasoning_effort else {
        return;
    };
    let name = config.model.to_ascii_lowercase().replace('.', "-");
    if name.starts_with("deepseek-v4-") && protocol != ApiProtocol::Responses {
        body["thinking"] =
            json!({ "type": if effort == ReasoningEffort::None { "disabled" } else { "enabled" } });
        if effort == ReasoningEffort::None {
            return;
        }
        if protocol == ApiProtocol::AnthropicMessages {
            body["output_config"] = json!({ "effort": effort });
        } else {
            body["reasoning_effort"] = json!(effort);
        }
        return;
    }
    match protocol {
        ApiProtocol::Responses => body["reasoning"] = json!({ "effort": effort }),
        ApiProtocol::ChatCompletions => body["reasoning_effort"] = json!(effort),
        ApiProtocol::AnthropicMessages => {
            body["output_config"] = json!({ "effort": effort });
            if name.starts_with("claude-") && !name.starts_with("claude-opus-4-5") {
                body["thinking"] = json!({ "type": "adaptive" });
            }
        }
        ApiProtocol::Auto => unreachable!("wire protocol must be resolved"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_encodings_and_defaults_do_not_invent_limits() {
        for protocol in [
            ApiProtocol::Responses,
            ApiProtocol::ChatCompletions,
            ApiProtocol::AnthropicMessages,
        ] {
            let mut config = ProviderConfig {
                base_url: "https://test/v1".into(),
                api_key: String::new(),
                model: "claude-sonnet-4.6".into(),
                api_protocol: protocol,
                reasoning_effort: Option::None,
            };
            let mut body = json!({});
            apply_reasoning(&mut body, &config, protocol);
            assert_eq!(body, json!({}));
            config.reasoning_effort = Some(ReasoningEffort::High);
            apply_reasoning(&mut body, &config, protocol);
            let pointer = match protocol {
                ApiProtocol::Responses => "/reasoning/effort",
                ApiProtocol::ChatCompletions => "/reasoning_effort",
                _ => "/output_config/effort",
            };
            assert_eq!(body.pointer(pointer), Some(&json!("high")));
            assert!(body.get("max_tokens").is_none());
            assert!(body.get("max_output_tokens").is_none());
        }
    }

    #[test]
    fn choices_are_family_specific_not_universal() {
        assert!(!reasoning_efforts("gpt-6-astra", ApiProtocol::Responses)
            .contains(&ReasoningEffort::None));
        assert!(
            reasoning_efforts("claude-sonnet-4.6", ApiProtocol::AnthropicMessages)
                .contains(&ReasoningEffort::Max)
        );
        assert!(
            !reasoning_efforts("claude-sonnet-4.6", ApiProtocol::AnthropicMessages)
                .contains(&ReasoningEffort::Xhigh)
        );
        for name in ["custom-model", "grok-4.6", "deepseek-v3.1"] {
            assert!(reasoning_efforts(name, ApiProtocol::ChatCompletions).is_empty());
        }
        assert_eq!(
            reasoning_efforts("deepseek-v4-pro", ApiProtocol::ChatCompletions),
            vec![
                ReasoningEffort::None,
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Max
            ]
        );
        assert!(
            !reasoning_efforts("gemini-3.1-pro", ApiProtocol::ChatCompletions)
                .contains(&ReasoningEffort::None)
        );
        assert!(
            reasoning_efforts("gemini-2.5-flash", ApiProtocol::ChatCompletions)
                .contains(&ReasoningEffort::None)
        );
    }

    #[test]
    fn deepseek_uses_native_thinking_toggle_without_claude_adaptive_mode() {
        for protocol in [ApiProtocol::ChatCompletions, ApiProtocol::AnthropicMessages] {
            let mut config = ProviderConfig {
                base_url: "https://test/v1".into(),
                api_key: String::new(),
                model: "deepseek-v4-pro".into(),
                api_protocol: protocol,
                reasoning_effort: Some(ReasoningEffort::None),
            };
            let mut body = json!({});
            apply_reasoning(&mut body, &config, protocol);
            assert_eq!(body, json!({"thinking":{"type":"disabled"}}));
            config.reasoning_effort = Some(ReasoningEffort::Max);
            apply_reasoning(&mut body, &config, protocol);
            assert_eq!(body["thinking"]["type"], "enabled");
            assert_eq!(
                body.pointer(if protocol == ApiProtocol::ChatCompletions {
                    "/reasoning_effort"
                } else {
                    "/output_config/effort"
                }),
                Some(&json!("max"))
            );
        }
    }
}
