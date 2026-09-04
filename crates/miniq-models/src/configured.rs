//! Selects the native wire protocol for a configured model.

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::{
    AnthropicProvider, ApiProtocol, CompletionRequest, DeltaStream, ModelProvider,
    OpenAiCompatProvider, ProviderConfig, ProviderError, ResponsesProvider,
};

pub struct ConfiguredProvider {
    config: ProviderConfig,
    chat: OpenAiCompatProvider,
    responses: ResponsesProvider,
    anthropic: AnthropicProvider,
    resolved: OnceCell<ApiProtocol>,
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
        let Ok(mut url) = reqwest::Url::parse(&self.config.base_url) else {
            return Ok(inferred);
        };
        {
            let mut segments = url.path_segments_mut().map_err(|_| {
                ProviderError::Config("provider base URL cannot contain model metadata".into())
            })?;
            segments.pop_if_empty();
            segments.push("models");
            segments.push(&self.config.model);
        }
        let response = match self.metadata_client.get(url).send().await {
            Ok(response) if response.status().is_success() => response,
            _ => return Ok(inferred),
        };
        let payload: Value = match response.json().await {
            Ok(payload) => payload,
            Err(_) => return Ok(inferred),
        };
        Ok(extract_protocol(&payload).unwrap_or(inferred))
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

    #[tokio::test]
    async fn auto_protocol_reads_provider_metadata() {
        let app = Router::new().route(
            "/v1/models/{model}",
            get(|| async {
                Json(json!({
                    "data": {"preferred_api_protocol": "anthropic_messages"}
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let provider = ConfiguredProvider::new(ProviderConfig {
            base_url: format!("http://{address}/v1"),
            api_key: String::new(),
            model: "custom-model".into(),
            api_protocol: ApiProtocol::Auto,
        });

        assert_eq!(
            provider.protocol().await.unwrap(),
            ApiProtocol::AnthropicMessages
        );
    }
}
