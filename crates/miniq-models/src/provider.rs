//! Provider-facing chat types and the `ModelProvider` trait.

use std::pin::Pin;

use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("provider returned {status}: {body}")]
    Api { status: u16, body: String },
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    #[error("configuration error: {0}")]
    Config(String),
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
    /// Set on `Tool` messages: which call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Set on `Assistant` messages that requested tool calls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallRequest>,
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
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: Vec::new(),
        }
    }
    fn plain(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
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
}

/// Streamed provider output.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatDelta {
    /// Incremental assistant text.
    Text(String),
    /// A complete tool call request (providers accumulate fragments before
    /// emitting this).
    ToolCall(ToolCallRequest),
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
}

impl ProviderConfig {
    /// Load from `MINIQ_BASE_URL` / `MINIQ_API_KEY` / `MINIQ_MODEL`.
    pub fn from_env() -> Result<Self, ProviderError> {
        let base_url = std::env::var("MINIQ_BASE_URL")
            .map_err(|_| ProviderError::Config("MINIQ_BASE_URL is not set".into()))?;
        let model = std::env::var("MINIQ_MODEL")
            .map_err(|_| ProviderError::Config("MINIQ_MODEL is not set".into()))?;
        let api_key = std::env::var("MINIQ_API_KEY").unwrap_or_default();
        Ok(Self {
            base_url,
            api_key,
            model,
        })
    }
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    /// Stream a completion. The stream ends with `ChatDelta::Finished`.
    async fn stream_complete(&self, request: CompletionRequest) -> Result<DeltaStream, ProviderError>;

    /// Human-readable provider identity for logs and settings.
    fn describe(&self) -> String;
}
