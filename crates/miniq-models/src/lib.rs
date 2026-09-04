//! miniq-models: LLM provider adapters.
//!
//! Providers only turn a chat request into a stream of deltas. They never
//! execute tools; tool calls are parsed and dispatched by the agent runtime.

mod anthropic;
mod configured;
mod image;
mod openai;
mod provider;
mod responses;
mod sse;

pub use anthropic::AnthropicProvider;
pub use configured::ConfiguredProvider;
pub use openai::OpenAiCompatProvider;
pub use provider::{
    ApiProtocol, ChatDelta, ChatImage, ChatMessage, ChatRole, CompletionRequest, DeltaStream,
    ModelProvider, ProviderConfig, ProviderContext, ProviderError, ToolCallRequest, ToolSpec,
};
pub use responses::ResponsesProvider;

pub mod mock;
