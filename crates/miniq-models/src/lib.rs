//! miniq-models: LLM provider adapters.
//!
//! Providers only turn a chat request into a stream of deltas. They never
//! execute tools; tool calls are parsed and dispatched by the agent runtime.

mod openai;
mod provider;

pub use openai::OpenAiCompatProvider;
pub use provider::{
    ChatDelta, ChatMessage, ChatRole, CompletionRequest, DeltaStream, ImageAttachment,
    ModelProvider, ProviderConfig, ProviderError, ToolCallRequest, ToolSpec,
};

pub mod mock;
