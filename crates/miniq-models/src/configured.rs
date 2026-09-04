//! Selects the native wire protocol for a configured model.

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::{
    AnthropicProvider, ApiProtocol, CompletionRequest, DeltaStream, ModelCapabilities,
    ModelProvider, OpenAiCompatProvider, ProviderConfig, ProviderError, ResponsesProvider,
};

pub struct ConfiguredProvider {
    config: ProviderConfig,
    chat: OpenAiCompatProvider,
    responses: ResponsesProvider,
    anthropic: AnthropicProvider,
    resolved: OnceCell<ApiProtocol>,
    capabilities: OnceCell<ModelCapabilities>,
    metadata_client: reqwest::Client,
}

impl ConfiguredProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            chat: OpenAiCompatProvider::new(config.clone()),
            responses: ResponsesProvider::new(config.clone()),
            anthropic: AnthropicProvider::new(config.clone()),
            config,
            resolved: OnceCell::new(),
            capabilities: OnceCell::new(),
            metadata_client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("valid metadata HTTP client configuration"),
        }
    }

    async fn protocol(&self) -> Result<ApiProtocol, ProviderError> {
        if self.config.api_protocol != ApiProtocol::Auto {
            return Ok(self.config.api_protocol);
        }
        self.resolved
            .get_or_try_init(|| async { self.resolve_auto_protocol().await })
            .await
            .copied()
    }

    async fn resolve_auto_protocol(&self) -> Result<ApiProtocol, ProviderError> {
        let inferred = infer_protocol(&self.config.model);
        Ok(self
            .model_capabilities()
            .await
            .preferred_api_protocol
            .unwrap_or(inferred))
    }

    async fn model_capabilities(&self) -> ModelCapabilities {
        self.capabilities
            .get_or_init(|| async { self.fetch_model_capabilities().await })
            .await
            .clone()
    }

    async fn fetch_model_capabilities(&self) -> ModelCapabilities {
        let Ok(mut url) = reqwest::Url::parse(&self.config.base_url) else {
            return ModelCapabilities::default();
        };
        {
            let Ok(mut segments) = url.path_segments_mut() else {
                return ModelCapabilities::default();
            };
            segments.pop_if_empty();
            segments.push("models");
            segments.push(&self.config.model);
        }
        let mut request = self.metadata_client.get(url);
        if !self.config.api_key.is_empty() {
            request = request.bearer_auth(&self.config.api_key);
        }
        let response = match request.send().await {
            Ok(response) if response.status().is_success() => response,
            _ => return ModelCapabilities::default(),
        };
        let payload: Value = match response.json().await {
            Ok(payload) => payload,
            Err(_) => return ModelCapabilities::default(),
        };
        extract_capabilities(&payload)
    }
}

fn infer_protocol(model: &str) -> ApiProtocol {
    let model = model.to_ascii_lowercase();
    if model.starts_with("claude-") {
        ApiProtocol::AnthropicMessages
    } else if model.starts_with("gpt-")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
        || model.contains("codex")
    {
        ApiProtocol::Responses
    } else {
        ApiProtocol::ChatCompletions
    }
}

fn extract_protocol(payload: &Value) -> Option<ApiProtocol> {
    payload
        .pointer("/data/preferred_api_protocol")
        .or_else(|| payload.get("preferred_api_protocol"))
        .and_then(Value::as_str)
        .and_then(|value| ApiProtocol::parse(value).ok())
        .filter(|protocol| *protocol != ApiProtocol::Auto)
}

fn metadata_value<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload
        .get("data")
        .and_then(|data| data.get(key))
        .or_else(|| payload.get(key))
}

fn positive_u32(value: Option<&Value>) -> Option<u32> {
    let value = value.and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
    })?;
    (value > 0 && value <= u32::MAX as u64).then_some(value as u32)
}

fn extract_capabilities(payload: &Value) -> ModelCapabilities {
    ModelCapabilities {
        preferred_api_protocol: extract_protocol(payload),
        max_output_tokens: positive_u32(
            metadata_value(payload, "max_output")
                .or_else(|| metadata_value(payload, "max_output_tokens")),
        ),
        max_context_tokens: positive_u32(
            metadata_value(payload, "max_tokens")
                .or_else(|| metadata_value(payload, "max_context_tokens"))
                .or_else(|| metadata_value(payload, "context_window")),
        ),
    }
}

#[async_trait]
impl ModelProvider for ConfiguredProvider {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        match self.protocol().await? {
            ApiProtocol::Auto => unreachable!("auto protocol must be resolved"),
            ApiProtocol::ChatCompletions => self.chat.stream_complete(request).await,
            ApiProtocol::Responses => self.responses.stream_complete(request).await,
            ApiProtocol::AnthropicMessages => self.anthropic.stream_complete(request).await,
        }
    }

    async fn capabilities(&self) -> ModelCapabilities {
        self.model_capabilities().await
    }

    fn describe(&self) -> String {
        format!(
            "configured {:?} {} @ {}",
            self.config.api_protocol, self.config.model, self.config.base_url
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use serde_json::json;

    #[test]
    fn infers_native_protocols_for_well_known_model_families() {
        assert_eq!(
            infer_protocol("claude-sonnet-4.6"),
            ApiProtocol::AnthropicMessages
        );
        assert_eq!(infer_protocol("gpt-5.6-sol"), ApiProtocol::Responses);
        assert_eq!(infer_protocol("o4-mini"), ApiProtocol::Responses);
        assert_eq!(
            infer_protocol("gemini-3.1-pro"),
            ApiProtocol::ChatCompletions
        );
    }

    #[test]
    fn model_metadata_overrides_name_inference() {
        let payload = json!({"data":{"preferred_api_protocol":"chat_completions"}});
        assert_eq!(
            extract_protocol(&payload),
            Some(ApiProtocol::ChatCompletions)
        );
    }

    #[test]
    fn extracts_oneapi_model_limits() {
        let payload = json!({
            "data": {
                "preferred_api_protocol": "responses",
                "max_tokens": 1_000_000,
                "max_output": "128000"
            }
        });

        assert_eq!(
            extract_capabilities(&payload),
            ModelCapabilities {
                preferred_api_protocol: Some(ApiProtocol::Responses),
                max_output_tokens: Some(128_000),
                max_context_tokens: Some(1_000_000),
            }
        );
    }

    #[tokio::test]
    async fn auto_protocol_reads_provider_metadata() {
        let app = Router::new().route(
            "/v1/models/{model}",
            get(|headers: axum::http::HeaderMap| async move {
                let authenticated = headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    == Some("Bearer metadata-secret");
                Json(json!({
                    "data": {
                        "preferred_api_protocol": if authenticated { "anthropic_messages" } else { "chat_completions" },
                        "max_tokens": 1_000_000,
                        "max_output": 128_000
                    }
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let provider = ConfiguredProvider::new(ProviderConfig {
            base_url: format!("http://{address}/v1"),
            api_key: "metadata-secret".into(),
            model: "custom-model".into(),
            api_protocol: ApiProtocol::Auto,
        });

        assert_eq!(
            provider.protocol().await.unwrap(),
            ApiProtocol::AnthropicMessages
        );
        assert_eq!(
            provider.capabilities().await,
            ModelCapabilities {
                preferred_api_protocol: Some(ApiProtocol::AnthropicMessages),
                max_output_tokens: Some(128_000),
                max_context_tokens: Some(1_000_000),
            }
        );
    }
}
