use super::*;
use futures_util::stream;
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Debug, Default)]
struct Checkpoints(Mutex<Vec<TurnCheckpoint>>);

#[async_trait]
impl CheckpointStore for Checkpoints {
    async fn save(&self, checkpoint: TurnCheckpoint) -> Result<(), AgentError> {
        self.0.lock().unwrap().push(checkpoint);
        Ok(())
    }
}

struct Executor {
    calls: Mutex<Vec<String>>,
    cancel: CancellationToken,
    cancel_after_first: bool,
    parallel: bool,
}

#[async_trait]
impl ToolExecutor for Executor {
    fn specs(&self) -> Vec<ToolSpec> {
        Vec::new()
    }
    fn execution_mode(&self, _: &ToolCallRequest) -> ToolExecutionMode {
        if self.parallel {
            ToolExecutionMode::Parallel
        } else {
            ToolExecutionMode::Sequential
        }
    }
    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        self.calls.lock().unwrap().push(call.id.clone());
        if call.id == "fail" {
            return Err(AgentError::Cancelled);
        }
        if self.cancel_after_first {
            self.cancel.cancel();
        }
        Ok(json!({"completed": call.id}))
    }
}

fn call(id: &str) -> ToolCallRequest {
    ToolCallRequest {
        id: id.into(),
        name: "write".into(),
        arguments: json!({"id": id}),
    }
}

async fn batch(
    ids: &[&str],
    parallel: bool,
    cancel_after_first: bool,
) -> (crate::checkpoint::RunState, Arc<Checkpoints>, Vec<String>) {
    let cancel = CancellationToken::new();
    let executor = Executor {
        calls: Default::default(),
        cancel: cancel.clone(),
        cancel_after_first,
        parallel,
    };
    let calls = ids.iter().map(|id| call(id)).collect::<Vec<_>>();
    let mut assistant = ChatMessage::assistant("working");
    assistant.tool_calls = calls.clone();
    let mut state =
        crate::checkpoint::RunState::new(vec![ChatMessage::user("old task"), assistant]);
    let store = Arc::new(Checkpoints::default());
    let limits = RunLimits {
        checkpoint: Some(store.clone()),
        ..RunLimits::default()
    };
    assert!(
        crate::tool_batch::execute(&executor, &calls, &mut state, &limits, &cancel)
            .await
            .is_err()
    );
    let executed = executor.calls.into_inner().unwrap();
    (state, store, executed)
}

#[tokio::test]
async fn cancellation_keeps_completed_results_and_unstarted_pairing() {
    let (state, _, executed) = batch(&["first", "second"], false, true).await;
    assert_eq!(executed, ["first"]);
    assert!(state.history[2].content.contains("completed"));
    assert!(state.history[3].content.contains("not_started"));
    for (request, result) in state.history[1].tool_calls.iter().zip(&state.history[2..]) {
        assert_eq!(result.tool_call_id.as_deref(), Some(request.id.as_str()));
    }
}

#[tokio::test]
async fn failed_sequential_call_is_unknown_without_losing_prior_success() {
    let (state, _, executed) = batch(&["first", "fail", "third"], false, false).await;
    assert_eq!(executed, ["first", "fail"]);
    assert!(state.history[2].content.contains("completed"));
    assert!(state.history[3].content.contains("unknown"));
    assert!(state.history[4].content.contains("not_started"));
}

#[tokio::test]
async fn parallel_failure_retains_successful_siblings_and_checkpoints_each_result() {
    let (state, store, executed) = batch(&["fail", "second", "third"], true, false).await;
    assert_eq!(executed.len(), 3);
    assert!(state.history[2].content.contains("unknown"));
    assert!(state.history[3].content.contains("completed"));
    assert!(state.history[4].content.contains("completed"));
    assert_eq!(store.0.lock().unwrap().len(), 5);
}

struct PartialProvider;

#[async_trait]
impl ModelProvider for PartialProvider {
    async fn stream_complete(
        &self,
        _: CompletionRequest,
    ) -> Result<miniq_models::DeltaStream, ProviderError> {
        Ok(Box::pin(stream::iter(vec![
            Ok(ChatDelta::Text("partial answer".into())),
            Err(ProviderError::Config("test failure".into())),
        ])))
    }
    fn describe(&self) -> String {
        "partial".into()
    }
}

#[tokio::test]
async fn terminal_provider_error_checkpoints_partial_text_as_plain_assistant() {
    let store = Arc::new(Checkpoints::default());
    let (events, _receiver) = tokio::sync::mpsc::channel(16);
    assert!(run_turn_with_limits(
        &PartialProvider,
        &NoTools,
        vec![
            ChatMessage::system("runtime"),
            ChatMessage::user("question")
        ],
        events,
        CancellationToken::new(),
        RunLimits {
            checkpoint: Some(store.clone()),
            ..RunLimits::default()
        },
    )
    .await
    .is_err());
    let checkpoints = store.0.lock().unwrap();
    let checkpoint = checkpoints.last().unwrap();
    assert!(checkpoint.stopped);
    assert_eq!(checkpoint.display_text, "partial answer");
    let partial = checkpoint.history.last().unwrap();
    assert_eq!(partial.content, "partial answer");
    assert!(partial.provider_context.is_none());
    assert!(partial.tool_calls.is_empty());
}

#[derive(Debug)]
struct FailingStore;

#[async_trait]
impl CheckpointStore for FailingStore {
    async fn save(&self, _: TurnCheckpoint) -> Result<(), AgentError> {
        Err(AgentError::Checkpoint("disk full".into()))
    }
}

#[tokio::test]
async fn persistence_failure_prevents_dispatching_side_effects() {
    let cancel = CancellationToken::new();
    let executor = Executor {
        calls: Default::default(),
        cancel: cancel.clone(),
        cancel_after_first: false,
        parallel: false,
    };
    let mut state = crate::checkpoint::RunState::new(Vec::new());
    let result = crate::tool_batch::execute(
        &executor,
        &[call("write")],
        &mut state,
        &RunLimits {
            checkpoint: Some(Arc::new(FailingStore)),
            ..RunLimits::default()
        },
        &cancel,
    )
    .await;
    assert!(matches!(result, Err(AgentError::Checkpoint(_))));
    assert!(executor.calls.lock().unwrap().is_empty());
}
