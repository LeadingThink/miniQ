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
mod context;

pub use context::{compact_history, estimate_tokens, ContextOutcome, ContextPolicy};

use futures_util::{future::join_all, StreamExt};
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
    #[error("agent stopped after {steps} model steps to prevent a runaway loop")]
    StepLimitExceeded { steps: usize },
    #[error("agent repeated the same tool batch {repetitions} times")]
    RepeatedToolLoop { repetitions: usize },
}

/// Events surfaced to the caller while a turn runs.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// Incremental assistant text.
    TextDelta(String),
    ContextCompacted {
        estimated_tokens_before: usize,
        estimated_tokens_after: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecutionMode {
    Sequential,
    Parallel,
}

/// Executes tool calls on behalf of the agent. Implementations own risk
/// evaluation, approval, persistence and audit.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Tool specs advertised to the model.
    fn specs(&self) -> Vec<ToolSpec>;

    fn execution_mode(&self, _call: &ToolCallRequest) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

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

#[derive(Debug)]
pub struct TurnOutcome {
    /// Final assistant text (last model message without tool calls).
    pub final_text: String,
    /// Full provider-facing transcript appended during this turn (assistant
    /// tool-call messages and tool results), excluding the incoming history.
    pub appended: Vec<ChatMessage>,
}

#[derive(Debug, Clone)]
pub struct RunLimits {
    pub max_steps: usize,
    pub repeated_tool_batch_limit: usize,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            max_steps: 96,
            repeated_tool_batch_limit: 4,
        }
    }
}

/// Run one turn to completion.
pub async fn run_turn(
    provider: &dyn ModelProvider,
    executor: &dyn ToolExecutor,
    history: Vec<ChatMessage>,
    events: tokio::sync::mpsc::Sender<AgentEvent>,
    cancel: CancellationToken,
) -> Result<TurnOutcome, AgentError> {
    run_turn_with_limits(
        provider,
        executor,
        history,
        events,
        cancel,
        RunLimits::default(),
    )
    .await
}

pub async fn run_turn_with_limits(
    provider: &dyn ModelProvider,
    executor: &dyn ToolExecutor,
    mut history: Vec<ChatMessage>,
    events: tokio::sync::mpsc::Sender<AgentEvent>,
    cancel: CancellationToken,
    limits: RunLimits,
) -> Result<TurnOutcome, AgentError> {
    let tools = executor.specs();
    let mut appended: Vec<ChatMessage> = Vec::new();
    let mut steps = 0;
    let mut last_tool_batch = String::new();
    let mut repeated_tool_batch = 0;

    loop {
        if cancel.is_cancelled() {
            return Err(AgentError::Cancelled);
        }
        steps += 1;
        if steps > limits.max_steps {
            return Err(AgentError::StepLimitExceeded {
                steps: limits.max_steps,
            });
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

        let batch_fingerprint = serde_json::to_string(
            &tool_calls
                .iter()
                .map(|call| (&call.name, &call.arguments))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default();
        if batch_fingerprint == last_tool_batch {
            repeated_tool_batch += 1;
        } else {
            last_tool_batch = batch_fingerprint;
            repeated_tool_batch = 1;
        }
        if repeated_tool_batch >= limits.repeated_tool_batch_limit {
            return Err(AgentError::RepeatedToolLoop {
                repetitions: repeated_tool_batch,
            });
        }

        // Record the assistant message that requested the calls.
        let assistant_msg = ChatMessage {
            role: miniq_models::ChatRole::Assistant,
            content: text,
            images: Vec::new(),
            tool_call_id: None,
            tool_calls: tool_calls.clone(),
        };
        history.push(assistant_msg.clone());
        appended.push(assistant_msg);

        let results = if tool_calls
            .iter()
            .all(|call| executor.execution_mode(call) == ToolExecutionMode::Parallel)
        {
            join_all(tool_calls.iter().map(|call| executor.execute(call))).await
        } else {
            let mut results = Vec::with_capacity(tool_calls.len());
            for call in &tool_calls {
                if cancel.is_cancelled() {
                    return Err(AgentError::Cancelled);
                }
                results.push(executor.execute(call).await);
            }
            results
        };
        for (call, result) in tool_calls.iter().zip(results) {
            let result = result?;
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

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
            arguments: serde_json::json!({"index": index}),
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

    #[tokio::test]
    async fn stops_a_repeated_identical_tool_loop() {
        let repeated = vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "call".to_string(),
            name: "continue_work".to_string(),
            arguments: serde_json::json!({"same": true}),
        })];
        let provider = MockProvider::new(vec![
            repeated.clone(),
            repeated.clone(),
            repeated.clone(),
            repeated,
        ]);
        let (events, _receiver) = tokio::sync::mpsc::channel(8);

        let error = run_turn_with_limits(
            &provider,
            &TestExecutor,
            Vec::new(),
            events,
            CancellationToken::new(),
            RunLimits {
                max_steps: 20,
                repeated_tool_batch_limit: 4,
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            AgentError::RepeatedToolLoop { repetitions: 4 }
        ));
    }

    struct ParallelExecutor {
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl ToolExecutor for ParallelExecutor {
        fn specs(&self) -> Vec<ToolSpec> {
            Vec::new()
        }

        fn execution_mode(&self, _call: &ToolCallRequest) -> ToolExecutionMode {
            ToolExecutionMode::Parallel
        }

        async fn execute(&self, _call: &ToolCallRequest) -> Result<Value, AgentError> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(serde_json::json!({"ok": true}))
        }
    }

    #[tokio::test]
    async fn executes_a_parallel_safe_tool_batch_concurrently() {
        let calls = (0..3)
            .map(|index| {
                ChatDelta::ToolCall(ToolCallRequest {
                    id: format!("call-{index}"),
                    name: "read".to_string(),
                    arguments: serde_json::json!({"index": index}),
                })
            })
            .collect();
        let provider = MockProvider::new(vec![calls, vec![ChatDelta::Text("done".into())]]);
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let executor = ParallelExecutor {
            active,
            peak: peak.clone(),
        };
        let (events, _receiver) = tokio::sync::mpsc::channel(8);

        let outcome = run_turn(
            &provider,
            &executor,
            Vec::new(),
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.final_text, "done");
        assert_eq!(peak.load(Ordering::SeqCst), 3);
    }
}
