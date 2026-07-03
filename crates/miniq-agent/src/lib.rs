//! miniq-agent: the turn runner.
//!
//! Orchestrates one agent turn: stream model output, forward text deltas,
//! dispatch tool calls to a [`ToolExecutor`], feed results back to the model
//! and repeat until the model answers without tool calls.
//!
//! This crate never touches SQLite or the OS. Persistence and real tool
//! execution live behind the `ToolExecutor` implementation supplied by the
//! daemon.

use async_trait::async_trait;
use futures_util::StreamExt;
use miniq_models::{
    ChatDelta, ChatMessage, CompletionRequest, ModelProvider, ToolCallRequest, ToolSpec,
};
use serde_json::Value;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("provider error: {0}")]
    Provider(#[from] miniq_models::ProviderError),
    #[error("turn cancelled")]
    Cancelled,
    #[error("max iterations ({0}) reached without a final answer")]
    MaxIterations(usize),
}

/// Events surfaced to the caller while a turn runs.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// Incremental assistant text.
    TextDelta(String),
}

/// Executes tool calls on behalf of the agent. Implementations own risk
/// evaluation, approval, persistence and audit.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Tool specs advertised to the model.
    fn specs(&self) -> Vec<ToolSpec>;

    /// Execute one call and return a structured result. Errors and
    /// rejections must be encoded in the returned JSON so the model can
    /// react to them; `Err` is reserved for turn-fatal failures.
    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError>;
}

/// A no-tool executor for plain chat turns.
pub struct NoTools;

#[async_trait]
impl ToolExecutor for NoTools {
    fn specs(&self) -> Vec<ToolSpec> {
        Vec::new()
    }
    async fn execute(&self, _call: &ToolCallRequest) -> Result<Value, AgentError> {
        Ok(serde_json::json!({
            "error": "no tools are available in this session"
        }))
    }
}

pub struct TurnOutcome {
    /// Final assistant text (last model message without tool calls).
    pub final_text: String,
    /// Full provider-facing transcript appended during this turn (assistant
    /// tool-call messages and tool results), excluding the incoming history.
    pub appended: Vec<ChatMessage>,
}

const MAX_ITERATIONS: usize = 24;

/// Run one turn to completion.
pub async fn run_turn(
    provider: &dyn ModelProvider,
    executor: &dyn ToolExecutor,
    mut history: Vec<ChatMessage>,
    events: tokio::sync::mpsc::Sender<AgentEvent>,
    cancel: CancellationToken,
) -> Result<TurnOutcome, AgentError> {
    let tools = executor.specs();
    let mut appended: Vec<ChatMessage> = Vec::new();

    for _ in 0..MAX_ITERATIONS {
        if cancel.is_cancelled() {
            return Err(AgentError::Cancelled);
        }
        let request = CompletionRequest {
            messages: history.clone(),
            tools: tools.clone(),
            temperature: None,
        };
        let mut stream = provider.stream_complete(request).await?;

        let mut text = String::new();
        let mut tool_calls: Vec<ToolCallRequest> = Vec::new();

        loop {
            let delta = tokio::select! {
                _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                delta = stream.next() => delta,
            };
            let Some(delta) = delta else { break };
            match delta? {
                ChatDelta::Text(t) => {
                    text.push_str(&t);
                    let _ = events.send(AgentEvent::TextDelta(t)).await;
                }
                ChatDelta::ToolCall(call) => tool_calls.push(call),
                ChatDelta::Finished => break,
            }
        }

        if tool_calls.is_empty() {
            return Ok(TurnOutcome {
                final_text: text,
                appended,
            });
        }

        // Record the assistant message that requested the calls.
        let assistant_msg = ChatMessage {
            role: miniq_models::ChatRole::Assistant,
            content: text,
            tool_call_id: None,
            tool_calls: tool_calls.clone(),
        };
        history.push(assistant_msg.clone());
        appended.push(assistant_msg);

        for call in &tool_calls {
            if cancel.is_cancelled() {
                return Err(AgentError::Cancelled);
            }
            let result = executor.execute(call).await?;
            let result_msg = ChatMessage::tool_result(call.id.clone(), result.to_string());
            history.push(result_msg.clone());
            appended.push(result_msg);
        }
    }

    Err(AgentError::MaxIterations(MAX_ITERATIONS))
}
