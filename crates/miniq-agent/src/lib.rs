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

    /// Persist assistant text emitted immediately before a tool round.
    async fn record_intermediate_text(&self, _text: &str) -> Result<(), AgentError> {
        Ok(())
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

pub struct TurnOutcome {
    /// Final assistant text (last model message without tool calls).
    pub final_text: String,
    /// Full provider-facing transcript appended during this turn (assistant
    /// tool-call messages and tool results), excluding the incoming history.
    pub appended: Vec<ChatMessage>,
}

fn visible_reasoning(reasoning: &str) -> String {
    let mut in_code_fence = false;
    let mut kept = Vec::new();

    for line in reasoning.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code_fence = !in_code_fence;
            kept.push(line);
            continue;
        }

        let has_chinese = line.chars().any(
            |character| matches!(character, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'),
        );
        let is_english_text = line
            .chars()
            .any(|character| character.is_ascii_alphabetic());
        if in_code_fence || has_chinese || !is_english_text {
            kept.push(line);
        }
    }

    kept.join("\n").trim().to_string()
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

        let mut reasoning = String::new();
        let mut text = String::new();
        let mut tool_calls: Vec<ToolCallRequest> = Vec::new();

        loop {
            let delta = tokio::select! {
                _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                delta = stream.next() => delta,
            };
            let Some(delta) = delta else { break };
            match delta? {
                ChatDelta::Reasoning(t) => reasoning.push_str(&t),
                ChatDelta::Text(t) => {
                    text.push_str(&t);
                    let _ = events.send(AgentEvent::TextDelta(t)).await;
                }
                ChatDelta::ToolCall(call) => tool_calls.push(call),
                ChatDelta::Finished => break,
            }
        }

        let reasoning = visible_reasoning(&reasoning);
        if tool_calls.is_empty() {
            if !reasoning.is_empty() {
                executor.record_intermediate_text(&reasoning).await?;
            }
            return Ok(TurnOutcome {
                final_text: text,
                appended,
            });
        }

        if !reasoning.is_empty() {
            executor.record_intermediate_text(&reasoning).await?;
        }
        if !text.is_empty() {
            executor.record_intermediate_text(&text).await?;
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
    use std::sync::Mutex;

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

    #[test]
    fn removes_english_only_reasoning_lines() {
        let reasoning = "Planning repository inspection\n\n已定位仓库，接下来读取关键文件。\n\nVerifying source claims";

        assert_eq!(
            visible_reasoning(reasoning),
            "已定位仓库，接下来读取关键文件。"
        );
    }

    #[test]
    fn removes_screenshot_style_english_heading() {
        let reasoning = "Planning multi-step repository inspection\n\n我会先定位 reference-repo 下的 DeepSeek Harness 仓库并梳理其实现。";

        assert_eq!(
            visible_reasoning(reasoning),
            "我会先定位 reference-repo 下的 DeepSeek Harness 仓库并梳理其实现。"
        );
    }

    #[test]
    fn preserves_code_blocks_in_reasoning() {
        let reasoning =
            "Running checks\n\n```powershell\nGet-ChildItem -Path .\n```\n\n正在检查结果。";

        assert_eq!(
            visible_reasoning(reasoning),
            "```powershell\nGet-ChildItem -Path .\n```\n\n正在检查结果。"
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
    async fn records_intermediate_text_before_executing_tools() {
        struct OrderedExecutor {
            events: Mutex<Vec<String>>,
        }

        #[async_trait]
        impl ToolExecutor for OrderedExecutor {
            fn specs(&self) -> Vec<ToolSpec> {
                TestExecutor.specs()
            }

            async fn record_intermediate_text(&self, text: &str) -> Result<(), AgentError> {
                self.events.lock().unwrap().push(format!("text:{text}"));
                Ok(())
            }

            async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
                self.events
                    .lock()
                    .unwrap()
                    .push(format!("tool:{}", call.id));
                Ok(serde_json::json!({ "completed": call.id }))
            }
        }

        let provider = MockProvider::new(vec![
            vec![ChatDelta::Text("before".into()), tool_turn(0).remove(0)],
            vec![ChatDelta::Text("after".into())],
        ]);
        let executor = OrderedExecutor {
            events: Mutex::new(Vec::new()),
        };
        let (events, _receiver) = tokio::sync::mpsc::channel(4);

        let outcome = run_turn(
            &provider,
            &executor,
            Vec::new(),
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.final_text, "after");
        assert_eq!(
            *executor.events.lock().unwrap(),
            ["text:before", "tool:call-0"]
        );
    }

    #[tokio::test]
    async fn records_provider_reasoning_before_tool_calls() {
        struct ProgressExecutor {
            text: Mutex<String>,
        }

        #[async_trait]
        impl ToolExecutor for ProgressExecutor {
            fn specs(&self) -> Vec<ToolSpec> {
                TestExecutor.specs()
            }

            async fn record_intermediate_text(&self, text: &str) -> Result<(), AgentError> {
                *self.text.lock().unwrap() = text.to_string();
                Ok(())
            }

            async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
                Ok(serde_json::json!({ "completed": call.id }))
            }
        }

        let provider = MockProvider::new(vec![
            vec![
                ChatDelta::Reasoning("先检查仓库".into()),
                tool_turn(0).remove(0),
            ],
            vec![ChatDelta::Text("finished".into())],
        ]);
        let executor = ProgressExecutor {
            text: Mutex::new(String::new()),
        };
        let (events, _receiver) = tokio::sync::mpsc::channel(4);

        run_turn(
            &provider,
            &executor,
            Vec::new(),
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(*executor.text.lock().unwrap(), "先检查仓库");
    }

    #[tokio::test]
    async fn records_provider_reasoning_before_the_final_answer() {
        struct ReasoningExecutor {
            text: Mutex<String>,
        }

        #[async_trait]
        impl ToolExecutor for ReasoningExecutor {
            fn specs(&self) -> Vec<ToolSpec> {
                Vec::new()
            }

            async fn record_intermediate_text(&self, text: &str) -> Result<(), AgentError> {
                *self.text.lock().unwrap() = text.to_string();
                Ok(())
            }

            async fn execute(&self, _call: &ToolCallRequest) -> Result<Value, AgentError> {
                unreachable!()
            }
        }

        let provider = MockProvider::new(vec![vec![
            ChatDelta::Reasoning("核对证据".into()),
            ChatDelta::Text("final answer".into()),
        ]]);
        let executor = ReasoningExecutor {
            text: Mutex::new(String::new()),
        };
        let (events, _receiver) = tokio::sync::mpsc::channel(4);

        let outcome = run_turn(
            &provider,
            &executor,
            Vec::new(),
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(*executor.text.lock().unwrap(), "核对证据");
        assert_eq!(outcome.final_text, "final answer");
    }
}
