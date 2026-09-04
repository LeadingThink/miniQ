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
    ModelRequestStarted {
        step: usize,
    },
    ModelResponseStarted {
        step: usize,
    },
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

    /// Stable semantic identity used by repeated-call protection. Executors
    /// that accept provider-native aliases should normalize them here.
    fn call_fingerprint(&self, call: &ToolCallRequest) -> String {
        serde_json::to_string(&(&call.name, &call.arguments)).unwrap_or_default()
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
    /// Provider transcript after any mid-turn compaction, including the final
    /// assistant message.
    pub provider_history: Vec<ChatMessage>,
}

#[derive(Debug, Clone)]
pub struct RunLimits {
    pub max_steps: usize,
    pub repeated_tool_batch_limit: usize,
    pub max_model_retries: usize,
    pub context_policy: ContextPolicy,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            max_steps: 96,
            repeated_tool_batch_limit: 4,
            max_model_retries: 2,
            context_policy: ContextPolicy::default(),
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
    let mut streamed_any_text = false;
    let mut trailing_stream_newlines = 0;

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
        let context =
            compact_history(provider, history, &limits.context_policy, &events, &cancel).await?;
        history = context.messages;

        let mut model_retry = 0;
        let mut output_budget = 16_384u32;
        let (text, tool_calls, provider_context) = loop {
            let request = CompletionRequest {
                messages: history.clone(),
                tools: tools.clone(),
                temperature: None,
                max_output_tokens: Some(output_budget),
            };
            let _ = events
                .send(AgentEvent::ModelRequestStarted { step: steps })
                .await;
            // Race the provider call against cancellation so an interrupt
            // takes effect while connecting or waiting for the first byte.
            let mut stream = tokio::select! {
                _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                stream = provider.stream_complete(request) => stream?,
            };
            let _ = events
                .send(AgentEvent::ModelResponseStarted { step: steps })
                .await;

            let mut text = String::new();
            let mut tool_calls: Vec<ToolCallRequest> = Vec::new();
            let mut provider_context = None;
            let mut started_text_segment = false;
            let mut stream_error = None;

            loop {
                let delta = tokio::select! {
                    _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                    delta = stream.next() => delta,
                };
                let Some(delta) = delta else { break };
                let delta = match delta {
                    Ok(delta) => delta,
                    Err(error) => {
                        stream_error = Some(error);
                        break;
                    }
                };
                match delta {
                    ChatDelta::Text(t) => {
                        if t.is_empty() {
                            continue;
                        }
                        if !started_text_segment {
                            if streamed_any_text {
                                let separator = if trailing_stream_newlines >= 2 {
                                    ""
                                } else if trailing_stream_newlines == 1 {
                                    "\n"
                                } else {
                                    "\n\n"
                                };
                                if !separator.is_empty() {
                                    let _ = events
                                        .send(AgentEvent::TextDelta(separator.to_string()))
                                        .await;
                                }
                            }
                            started_text_segment = true;
                        }
                        text.push_str(&t);
                        streamed_any_text = true;
                        for character in t.chars() {
                            trailing_stream_newlines = if character == '\n' {
                                (trailing_stream_newlines + 1).min(2)
                            } else {
                                0
                            };
                        }
                        let _ = events.send(AgentEvent::TextDelta(t)).await;
                    }
                    ChatDelta::ToolCall(call) => tool_calls.push(call),
                    ChatDelta::Context(context) => provider_context = Some(context),
                    ChatDelta::Finished => break,
                }
            }

            if let Some(error) = stream_error {
                if text.is_empty() && model_retry < limits.max_model_retries {
                    if matches!(
                        &error,
                        miniq_models::ProviderError::OutputLimitReached
                            | miniq_models::ProviderError::IncompleteToolArguments { .. }
                    ) {
                        output_budget = output_budget.saturating_mul(2).min(65_536);
                    }
                    model_retry += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(250 * model_retry as u64))
                        .await;
                    continue;
                }
                return Err(AgentError::Provider(error));
            }
            if text.trim().is_empty()
                && tool_calls.is_empty()
                && model_retry < limits.max_model_retries
            {
                model_retry += 1;
                tokio::time::sleep(std::time::Duration::from_millis(250 * model_retry as u64))
                    .await;
                continue;
            }
            break (text, tool_calls, provider_context);
        };

        if tool_calls.is_empty() {
            if text.trim().is_empty() {
                return Err(AgentError::Provider(
                    miniq_models::ProviderError::InvalidResponse(format!(
                        "provider returned an empty completion after {} attempts",
                        limits.max_model_retries + 1
                    )),
                ));
            }
            let mut provider_history = history.clone();
            let mut assistant = ChatMessage::assistant(text.clone());
            assistant.provider_context = provider_context;
            provider_history.push(assistant);
            return Ok(TurnOutcome {
                final_text: text,
                appended,
                provider_history,
            });
        }

        let batch_fingerprint = tool_calls
            .iter()
            .map(|call| executor.call_fingerprint(call))
            .collect::<Vec<_>>()
            .join("\n");
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
            provider_context,
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
    use futures_util::stream;
    use miniq_models::mock::MockProvider;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
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

    struct FallibleProvider {
        turns: Mutex<std::vec::IntoIter<Vec<Result<ChatDelta, miniq_models::ProviderError>>>>,
        requests: Mutex<Vec<CompletionRequest>>,
    }

    impl FallibleProvider {
        fn new(turns: Vec<Vec<Result<ChatDelta, miniq_models::ProviderError>>>) -> Self {
            Self {
                turns: Mutex::new(turns.into_iter()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl ModelProvider for FallibleProvider {
        async fn stream_complete(
            &self,
            request: CompletionRequest,
        ) -> Result<miniq_models::DeltaStream, miniq_models::ProviderError> {
            self.requests.lock().unwrap().push(request);
            let turn = self.turns.lock().unwrap().next().ok_or_else(|| {
                miniq_models::ProviderError::Config("no scripted turn".to_string())
            })?;
            Ok(Box::pin(stream::iter(turn)))
        }

        fn describe(&self) -> String {
            "fallible-test-provider".to_string()
        }
    }

    #[tokio::test]
    async fn reports_model_request_and_response_phases() {
        let provider = MockProvider::new(vec![vec![ChatDelta::Text("完成".to_string())]]);
        let (events, mut receiver) = tokio::sync::mpsc::channel(8);

        run_turn(
            &provider,
            &TestExecutor,
            Vec::new(),
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(matches!(
            receiver.try_recv().unwrap(),
            AgentEvent::ModelRequestStarted { step: 1 }
        ));
        assert!(matches!(
            receiver.try_recv().unwrap(),
            AgentEvent::ModelResponseStarted { step: 1 }
        ));
        assert!(matches!(
            receiver.try_recv().unwrap(),
            AgentEvent::TextDelta(delta) if delta == "完成"
        ));
    }

    #[tokio::test]
    async fn separates_text_from_sequential_model_steps_without_splitting_chunks() {
        let mut inspect = vec![
            ChatDelta::Text("检查".to_string()),
            ChatDelta::Text("文件".to_string()),
        ];
        inspect.extend(tool_turn(0));
        let mut analyze = vec![ChatDelta::Text("分析完成\n".to_string())];
        analyze.extend(tool_turn(1));
        let mut edit = vec![ChatDelta::Text("修改完成\n\n".to_string())];
        edit.extend(tool_turn(2));
        let provider = MockProvider::new(vec![
            inspect,
            analyze,
            edit,
            vec![ChatDelta::Text("全部完成".to_string())],
        ]);
        let (events, mut receiver) = tokio::sync::mpsc::channel(16);

        run_turn(
            &provider,
            &TestExecutor,
            Vec::new(),
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        let mut deltas = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            if let AgentEvent::TextDelta(delta) = event {
                deltas.push(delta);
            }
        }
        assert_eq!(
            deltas,
            vec![
                "检查",
                "文件",
                "\n\n",
                "分析完成\n",
                "\n",
                "修改完成\n\n",
                "全部完成",
            ]
        );
    }

    #[tokio::test]
    async fn preserves_provider_context_across_tool_steps_and_final_history() {
        let tool_context = miniq_models::ProviderContext {
            protocol: miniq_models::ApiProtocol::AnthropicMessages,
            data: serde_json::json!([
                {"type":"thinking","thinking":"private","signature":"signed"},
                {"type":"tool_use","id":"call-0","name":"continue_work","input":{"index":0}}
            ]),
        };
        let final_context = miniq_models::ProviderContext {
            protocol: miniq_models::ApiProtocol::AnthropicMessages,
            data: serde_json::json!([{"type":"text","text":"done"}]),
        };
        let provider = MockProvider::new(vec![
            vec![
                ChatDelta::Context(tool_context.clone()),
                ChatDelta::ToolCall(ToolCallRequest {
                    id: "call-0".into(),
                    name: "continue_work".into(),
                    arguments: serde_json::json!({"index": 0}),
                }),
            ],
            vec![
                ChatDelta::Text("done".into()),
                ChatDelta::Context(final_context.clone()),
            ],
        ]);
        let (events, _receiver) = tokio::sync::mpsc::channel(8);

        let outcome = run_turn(
            &provider,
            &TestExecutor,
            vec![ChatMessage::user("work")],
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome.appended[0].provider_context,
            Some(tool_context.clone())
        );
        assert_eq!(
            provider.requests.lock().unwrap()[1].messages[1].provider_context,
            Some(tool_context)
        );
        assert_eq!(
            outcome.provider_history.last().unwrap().provider_context,
            Some(final_context)
        );
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
    async fn retries_an_empty_completion_instead_of_saving_it() {
        let provider = MockProvider::new(vec![Vec::new(), vec![ChatDelta::Text("done".into())]]);
        let (events, _receiver) = tokio::sync::mpsc::channel(16);

        let outcome = run_turn(
            &provider,
            &TestExecutor,
            vec![ChatMessage::user("work")],
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.final_text, "done");
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].max_output_tokens, Some(16_384));
        assert_eq!(requests[1].max_output_tokens, Some(16_384));
    }

    #[tokio::test]
    async fn raises_output_budget_after_a_truncated_response() {
        let provider = FallibleProvider::new(vec![
            vec![Err(miniq_models::ProviderError::OutputLimitReached)],
            vec![
                Ok(ChatDelta::Text("complete".into())),
                Ok(ChatDelta::Finished),
            ],
        ]);
        let (events, _receiver) = tokio::sync::mpsc::channel(16);

        let outcome = run_turn(
            &provider,
            &TestExecutor,
            vec![ChatMessage::user("work")],
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.final_text, "complete");
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests[0].max_output_tokens, Some(16_384));
        assert_eq!(requests[1].max_output_tokens, Some(32_768));
    }

    #[tokio::test]
    async fn returns_a_clear_error_when_empty_retries_are_exhausted() {
        let provider = MockProvider::new(vec![Vec::new(), Vec::new(), Vec::new()]);
        let (events, _receiver) = tokio::sync::mpsc::channel(16);

        let error = run_turn(
            &provider,
            &TestExecutor,
            vec![ChatMessage::user("work")],
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("empty completion after 3 attempts"));
    }

    struct LargeResultExecutor;

    #[async_trait]
    impl ToolExecutor for LargeResultExecutor {
        fn specs(&self) -> Vec<ToolSpec> {
            TestExecutor.specs()
        }

        async fn execute(&self, _call: &ToolCallRequest) -> Result<Value, AgentError> {
            Ok(serde_json::json!({"content": "x".repeat(4_000)}))
        }
    }

    #[tokio::test]
    async fn compacts_large_tool_results_during_the_same_turn() {
        let provider = MockProvider::new(vec![
            tool_turn(0),
            vec![ChatDelta::Text("finished".to_string())],
        ]);
        let (events, mut receiver) = tokio::sync::mpsc::channel(32);
        let limits = RunLimits {
            context_policy: ContextPolicy {
                soft_limit_tokens: 100,
                preserve_recent_messages: 0,
                prune_tool_results_over_tokens: 10,
                summary_batch_tokens: 100,
            },
            ..RunLimits::default()
        };

        let outcome = run_turn_with_limits(
            &provider,
            &LargeResultExecutor,
            vec![ChatMessage::user("work")],
            events,
            CancellationToken::new(),
            limits,
        )
        .await
        .unwrap();

        let tool_result = outcome
            .provider_history
            .iter()
            .find(|message| message.role == miniq_models::ChatRole::Tool)
            .unwrap();
        assert!(tool_result.content.contains("old_tool_result"));
        let mut saw_compaction = false;
        while let Ok(event) = receiver.try_recv() {
            saw_compaction |= matches!(event, AgentEvent::ContextCompacted { .. });
        }
        assert!(saw_compaction);
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
                ..RunLimits::default()
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
