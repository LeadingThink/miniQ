//! Provider-facing chat types and the `ModelProvider` trait.

use std::pin::Pin;

use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiProtocol {
    #[default]
    Auto,
    ChatCompletions,
    Responses,
    AnthropicMessages,
}

impl ApiProtocol {
    pub fn parse(value: &str) -> Result<Self, ProviderError> {
        match value.trim() {
            "auto" => Ok(Self::Auto),
            "chat_completions" => Ok(Self::ChatCompletions),
            "responses" => Ok(Self::Responses),
            "anthropic_messages" => Ok(Self::AnthropicMessages),
            other => Err(ProviderError::Config(format!(
                "unsupported API protocol: {other}"
            ))),
        }
    }
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("provider returned {status}: {body}")]
    Api { status: u16, body: String },
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    #[error("provider stopped because the output token limit was reached")]
    OutputLimitReached,
    #[error("provider context window was exceeded")]
    ContextWindowExceeded,
    #[error("provider stream ended before a terminal event")]
    IncompleteStream,
    #[error("tool call {tool} ended with incomplete JSON arguments: {detail}")]
    IncompleteToolArguments { tool: String, detail: String },
    #[error("configuration error: {0}")]
    Config(String),
}

impl ProviderError {
    pub(crate) fn from_api_response(status: u16, body: String) -> Self {
        if indicates_context_window_overflow(&body) {
            Self::ContextWindowExceeded
        } else {
            Self::Api { status, body }
        }
    }

    pub(crate) fn from_stream_detail(prefix: &str, detail: &str) -> Self {
        if indicates_context_window_overflow(detail) {
            Self::ContextWindowExceeded
        } else {
            Self::InvalidResponse(format!("{prefix}: {detail}"))
        }
    }
}

fn indicates_context_window_overflow(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("context_length_exceeded")
        || detail.contains("context window")
        || detail.contains("maximum context length")
        || detail.contains("model_context_window_exceeded")
        || detail.contains("input is too long")
        || detail.contains("input exceeds")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

/// One message in the provider conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    /// Local images explicitly attached by the user. The OpenAI-compatible
    /// adapter reads them only while building the provider request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ChatImage>,
    /// Set on `Tool` messages: which call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Set on `Assistant` messages that requested tool calls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallRequest>,
    /// Provider-native assistant output that must be replayed verbatim on a
    /// later model step (for example reasoning or signed thinking blocks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_context: Option<ProviderContext>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderContext {
    pub protocol: ApiProtocol,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatImage {
    pub path: String,
    pub mime_type: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::System, content)
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::User, content)
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self::plain(ChatRole::Assistant, content)
    }
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Tool,
            content: content.into(),
            images: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: Vec::new(),
            provider_context: None,
        }
    }
    fn plain(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            images: Vec::new(),
            tool_call_id: None,
            tool_calls: Vec::new(),
            provider_context: None,
        }
    }
}

/// A tool call the model asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    /// Parsed JSON arguments.
    pub arguments: Value,
}

/// Tool made available to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the input object.
    pub parameters: Value,
}

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub temperature: Option<f32>,
    /// Maximum completion budget. Agent retries can raise this after a
    /// provider reports a truncated output.
    pub max_output_tokens: Option<u32>,
}

/// Limits and protocol preference advertised by the configured model endpoint.
/// Missing limits remain unknown rather than being replaced with guessed values.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub preferred_api_protocol: Option<ApiProtocol>,
    pub max_output_tokens: Option<u32>,
    pub max_context_tokens: Option<u32>,
}

/// Streamed provider output.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatDelta {
    /// Incremental assistant text.
    Text(String),
    /// A complete tool call request (providers accumulate fragments before
    /// emitting this).
    ToolCall(ToolCallRequest),
    /// Complete provider-native assistant output for lossless replay.
    Context(ProviderContext),
    /// Stream finished normally.
    Finished,
}

pub type DeltaStream = Pin<Box<dyn Stream<Item = Result<ChatDelta, ProviderError>> + Send>>;

/// Provider configuration for OpenAI-compatible endpoints.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub api_protocol: ApiProtocol,
}

impl ProviderConfig {
    /// Load from `MINIQ_BASE_URL` / `MINIQ_API_KEY` / `MINIQ_MODEL`.
    pub fn from_env() -> Result<Self, ProviderError> {
        let base_url = std::env::var("MINIQ_BASE_URL")
            .map_err(|_| ProviderError::Config("MINIQ_BASE_URL is not set".into()))?;
        let model = std::env::var("MINIQ_MODEL")
            .map_err(|_| ProviderError::Config("MINIQ_MODEL is not set".into()))?;
        let api_key = std::env::var("MINIQ_API_KEY").unwrap_or_default();
        let api_protocol = std::env::var("MINIQ_API_PROTOCOL")
            .ok()
            .map(|value| ApiProtocol::parse(&value))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            base_url,
            api_key,
            model,
            api_protocol,
        })
    }
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    /// Stream a completion. The stream ends with `ChatDelta::Finished`.
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError>;

    /// Fetch model limits without starting a completion. Providers that do
    /// not expose metadata return an empty capability set.
    async fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities::default()
    }

    /// Human-readable provider identity for logs and settings.
    fn describe(&self) -> String;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_context_overflow_from_common_provider_shapes() {
        for detail in [
            "Your input exceeds the context window of this model.",
            r#"{"error":{"code":"context_length_exceeded"}}"#,
            "maximum context length is 100000 tokens",
            "model_context_window_exceeded",
        ] {
            assert!(matches!(
                ProviderError::from_stream_detail("provider error", detail),
                ProviderError::ContextWindowExceeded
            ));
        }
    }

    #[test]
    fn preserves_unrelated_api_errors() {
        let error = ProviderError::from_api_response(429, "rate limited".into());
        assert!(matches!(error, ProviderError::Api { status: 429, .. }));
    }
}
