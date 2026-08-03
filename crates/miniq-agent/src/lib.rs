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

    loop {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_models::mock::MockProvider;

    struct TestExecutor;

    #[async_trait]
    impl ToolExecutor for TestExecutor {
        fn specs(&self) -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "continue_work".to_string(),
                description: "Continue the test task".to_string(),
                parameters: serde_json::json!({ "type": "object" }),
            }]
        }

        async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
            Ok(serde_json::json!({ "completed": call.id }))
        }
    }

    fn tool_turn(index: usize) -> Vec<ChatDelta> {
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: format!("call-{index}"),
            name: "continue_work".to_string(),
            arguments: serde_json::json!({}),
        })]
    }

    #[tokio::test]
    async fn continues_until_final_answer_after_more_than_24_tool_rounds() {
        let mut turns = (0..25).map(tool_turn).collect::<Vec<_>>();
        turns.push(vec![ChatDelta::Text("finished".to_string())]);
        let provider = MockProvider::new(turns);
        let (events, _receiver) = tokio::sync::mpsc::channel(64);

        let outcome = run_turn(
            &provider,
            &TestExecutor,
            Vec::new(),
            events,
            CancellationToken::new(),
        )
        .await
        .expect("the turn should continue past the previous limit");

        assert_eq!(outcome.final_text, "finished");
        assert_eq!(outcome.appended.len(), 50);
        assert_eq!(provider.requests.lock().unwrap().len(), 26);
    }

    #[tokio::test]
    async fn cancellation_still_stops_the_unbounded_loop() {
        let provider = MockProvider::new(vec![tool_turn(0)]);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (events, _receiver) = tokio::sync::mpsc::channel(1);

        let error = match run_turn(&provider, &TestExecutor, Vec::new(), events, cancel).await {
            Ok(_) => panic!("a cancelled turn must stop"),
            Err(error) => error,
        };

        assert!(matches!(error, AgentError::Cancelled));
    }
}
