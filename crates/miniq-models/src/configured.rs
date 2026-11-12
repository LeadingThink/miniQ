//! Selects the native wire protocol for a configured model.

use async_trait::async_trait;
use serde_json::Value;
use std::time::{Duration, Instant};
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
    fallback: OnceCell<ApiProtocol>,
    capabilities: OnceCell<CapabilitySnapshot>,
    metadata_client: reqwest::Client,
}

const METADATA_TTL: Duration = Duration::from_secs(300);
const INCOMPLETE_METADATA_TTL: Duration = Duration::from_secs(30);

struct CapabilitySnapshot {
    value: ModelCapabilities,
    fetched_at: Instant,
    ttl: Duration,
}

impl ConfiguredProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            chat: OpenAiCompatProvider::new(config.clone()),
            responses: ResponsesProvider::new(config.clone()),
            anthropic: AnthropicProvider::new(config.clone()),
            config,
            resolved: OnceCell::new(),
            fallback: OnceCell::new(),
            capabilities: OnceCell::new(),
            metadata_client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("valid metadata HTTP client configuration"),
        }
    }

    /// Reuse only at turn boundaries. Existing holders retain their negotiated
    /// protocol and metadata for the whole task, including after expiration.
    pub fn is_cache_fresh(&self) -> bool {
        self.capabilities
            .get()
            .is_none_or(|snapshot| snapshot.fetched_at.elapsed() < snapshot.ttl)
    }

    pub async fn protocol(&self) -> Result<ApiProtocol, ProviderError> {
        if self.config.api_protocol != ApiProtocol::Auto {
            return Ok(self.config.api_protocol);
        }
        if let Some(protocol) = self.fallback.get() {
            return Ok(*protocol);
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
            .value
            .clone()
    }

    async fn fallback_protocol(&self, current: ApiProtocol) -> Option<ApiProtocol> {
        if self.config.api_protocol != ApiProtocol::Auto
            || current != ApiProtocol::Responses
            || self.fallback.get().is_some()
        {
            return None;
        }
        // Recover the observed Responses route failure only when the same
        // model explicitly advertises Chat Completions. Never guess another
        // protocol or bounce back to the failed route later in the turn.
        self.model_capabilities()
            .await
            .supported_api_protocols?
            .contains(&ApiProtocol::ChatCompletions)
            .then_some(ApiProtocol::ChatCompletions)
    }

    async fn stream_with_protocol(
        &self,
        protocol: ApiProtocol,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        match protocol {
            ApiProtocol::Auto => unreachable!("auto protocol must be resolved"),
            ApiProtocol::ChatCompletions => self.chat.stream_complete(request).await,
            ApiProtocol::Responses => self.responses.stream_complete(request).await,
            ApiProtocol::AnthropicMessages => self.anthropic.stream_complete(request).await,
        }
    }

    async fn effective_output_tokens(
        &self,
        protocol: ApiProtocol,
        requested: Option<u32>,
    ) -> Option<u32> {
        if requested.is_some() || protocol != ApiProtocol::AnthropicMessages {
            return requested;
        }
        // Anthropic requires max_tokens. Use the endpoint's advertised model
        // limit when the caller intentionally leaves the provider default
        // unset; the native adapter retains a conservative fallback only when
        // a metadata endpoint cannot describe the model.
        self.model_capabilities().await.max_output_tokens
    }

    /// Endpoint metadata first, then the catalog row. OneAPI-style gateways
    /// publish `supported_reasoning_efforts` only in the paginated
    /// `/models/details` catalog, and their per-model route may be missing --
    /// or unreachable for namespaced IDs such as `hy/deepseek-v4.1-flash-1017`,
    /// which the detail URL encodes as one path segment.
    async fn fetch_model_capabilities(&self) -> CapabilitySnapshot {
        let detail = self.fetch_model_detail().await;
        let (capabilities, complete) = match detail {
            Some(detail) if detail.reasoning_efforts.is_some() => (detail, true),
            detail => match self.fetch_catalog_row().await {
                Some(row) => (
                    merge_capabilities(detail.unwrap_or_default(), extract_capabilities(&row)),
                    true,
                ),
                None => (detail.unwrap_or_default(), false),
            },
        };
        let ttl = if complete && capabilities != ModelCapabilities::default() {
            METADATA_TTL
        } else {
            INCOMPLETE_METADATA_TTL
        };
        CapabilitySnapshot {
            value: cap_model_context(&self.config.model, capabilities),
            fetched_at: Instant::now(),
            ttl,
        }
    }

    async fn fetch_model_detail(&self) -> Option<ModelCapabilities> {
        let Ok(mut url) = reqwest::Url::parse(&self.config.base_url) else {
            return None;
        };
        {
            let Ok(mut segments) = url.path_segments_mut() else {
                return None;
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
            _ => return None,
        };
        let payload: Value = match response.json().await {
            Ok(payload) => payload,
            Err(_) => return None,
        };
        Some(extract_capabilities(&payload))
    }

    async fn fetch_catalog_row(&self) -> Option<Value> {
        let base = reqwest::Url::parse(&self.config.base_url).ok()?;
        let wanted = self.config.model.trim().to_ascii_lowercase();
        for page in 1..=CATALOG_PAGE_LIMIT {
            let mut url = base.clone();
            {
                let mut segments = url.path_segments_mut().ok()?;
                segments.pop_if_empty();
                segments.push("models");
                segments.push("details");
            }
            url.query_pairs_mut()
                .append_pair("page", &page.to_string())
                .append_pair("page_size", &CATALOG_PAGE_SIZE.to_string());
            let mut request = self.metadata_client.get(url);
            if !self.config.api_key.is_empty() {
                request = request.bearer_auth(&self.config.api_key);
            }
            let payload: Value = match request.send().await {
                Ok(response) if response.status().is_success() => match response.json().await {
                    Ok(payload) => payload,
                    Err(_) => return None,
                },
                _ => return None,
            };
            let rows = payload.pointer("/data/models").and_then(Value::as_array)?;
            if let Some(row) = rows
                .iter()
                .find(|row| matches_requested_model(row, &wanted))
            {
                return Some(row.clone());
            }
            let received = rows.len();
            let complete = match payload.pointer("/data/total").and_then(Value::as_u64) {
                Some(total) => u64::from(page) * u64::from(CATALOG_PAGE_SIZE) >= total,
                None => received < CATALOG_PAGE_SIZE as usize,
            };
            if received == 0 || complete {
                return None;
            }
        }
        None
    }
}

const CATALOG_PAGE_SIZE: u32 = 100;
const CATALOG_PAGE_LIMIT: u32 = 10;

fn matches_requested_model(row: &Value, wanted: &str) -> bool {
    ["model_id", "id", "name"].iter().any(|key| {
        row.get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| value.trim().eq_ignore_ascii_case(wanted))
    })
}

/// The detail route wins where it answers; the catalog fills the rest.
fn merge_capabilities(
    primary: ModelCapabilities,
    fallback: ModelCapabilities,
) -> ModelCapabilities {
    ModelCapabilities {
        preferred_api_protocol: primary
            .preferred_api_protocol
            .or(fallback.preferred_api_protocol),
        supported_api_protocols: primary
            .supported_api_protocols
            .or(fallback.supported_api_protocols),
        max_output_tokens: primary.max_output_tokens.or(fallback.max_output_tokens),
        max_context_tokens: primary.max_context_tokens.or(fallback.max_context_tokens),
        reasoning_efforts: primary.reasoning_efforts.or(fallback.reasoning_efforts),
    }
}

/// Keep the local compaction policy below the effective OneAPI Grok boundary.
/// The gateway advertises 500k tokens, but logs show the upstream rejecting
/// Responses requests at roughly 220k input tokens. Cap the effective window
/// at 220k so the 90% local compaction threshold stays below 200k.
fn cap_model_context(model: &str, mut capabilities: ModelCapabilities) -> ModelCapabilities {
    if model.to_ascii_lowercase().starts_with("grok-") {
        capabilities.max_context_tokens = Some(
            capabilities
                .max_context_tokens
                .unwrap_or(220_000)
                .min(220_000),
        );
    }
    capabilities
}

pub fn infer_protocol(model: &str) -> ApiProtocol {
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

fn extract_protocols(payload: &Value) -> Option<Vec<ApiProtocol>> {
    let protocols = metadata_value(payload, "supported_api_protocols")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|value| ApiProtocol::parse(value).ok())
        .filter(|protocol| *protocol != ApiProtocol::Auto)
        .collect::<Vec<_>>();
    (!protocols.is_empty()).then_some(protocols)
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
        supported_api_protocols: extract_protocols(payload),
        max_output_tokens: positive_u32(
            metadata_value(payload, "max_output")
                .or_else(|| metadata_value(payload, "max_output_tokens")),
        ),
        max_context_tokens: positive_u32(
            metadata_value(payload, "max_tokens")
                .or_else(|| metadata_value(payload, "max_context_tokens"))
                .or_else(|| metadata_value(payload, "context_window")),
        ),
        reasoning_efforts: metadata_value(payload, "supported_reasoning_efforts")
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
    }
}

#[async_trait]
impl ModelProvider for ConfiguredProvider {
    async fn execution_info(
        &self,
        max_output_tokens: Option<u32>,
    ) -> Result<Option<miniq_protocol::ModelExecutionInfo>, ProviderError> {
        let protocol = self.protocol().await?;
        let max_output_tokens = self
            .effective_output_tokens(protocol, max_output_tokens)
            .await;
        match protocol {
            ApiProtocol::ChatCompletions => self.chat.execution_info(max_output_tokens).await,
            ApiProtocol::Responses => self.responses.execution_info(max_output_tokens).await,
            ApiProtocol::AnthropicMessages => {
                self.anthropic.execution_info(max_output_tokens).await
            }
            ApiProtocol::Auto => unreachable!("resolved protocol"),
        }
    }

    async fn stream_complete(
        &self,
        mut request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let protocol = self.protocol().await?;
        request.max_output_tokens = self
            .effective_output_tokens(protocol, request.max_output_tokens)
            .await;
        if let Some(effort) = self.config.reasoning_effort {
            let choices = self
                .model_capabilities()
                .await
                .reasoning_efforts
                .unwrap_or_else(|| crate::reasoning_efforts(&self.config.model, protocol));
            if !choices.contains(&effort) {
                return Err(ProviderError::Config(format!(
                    "model {} does not advertise reasoning effort {effort:?}",
                    self.config.model
                )));
            }
        }
        let Some(fallback) = self.fallback_protocol(protocol).await else {
            return self.stream_with_protocol(protocol, request).await;
        };
        match self.stream_with_protocol(protocol, request.clone()).await {
            Err(error) if error.is_protocol_route_not_found() => {
                let result = self.stream_with_protocol(fallback, request).await;
                if result.is_ok() {
                    // Cache only an endpoint that accepted the request.
                    let _ = self.fallback.set(fallback);
                }
                result
            }
            result => result,
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
mod tests;

#[cfg(test)]
mod cache_tests;
