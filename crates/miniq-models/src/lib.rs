//! miniq-models: LLM provider adapters.
//!
//! Providers only turn a chat request into a stream of deltas. They never
//! execute tools; tool calls are parsed and dispatched by the agent runtime.

mod anthropic;
mod compat_schema;
mod configured;
mod error;
mod image;
mod openai;
mod provider;
mod reasoning;
mod response_info;
pub use miniq_protocol::{ModelCallPurpose, ModelCallTrace};
mod responses;
mod responses_request;
mod sse;

pub use anthropic::AnthropicProvider;
pub use configured::{infer_protocol, ConfiguredProvider};
pub use openai::OpenAiCompatProvider;
pub use provider::{
    ApiProtocol, ChatDelta, ChatImage, ChatMessage, ChatRole, CompletionRequest, DeltaStream,
    ImageDetail, ModelCapabilities, ModelProvider, OutputTokenUsage, ProviderConfig,
    ProviderContext, ProviderError, ToolCallRequest, ToolSpec,
};
pub use reasoning::reasoning_efforts;
pub use responses::ResponsesProvider;

pub mod mock;
