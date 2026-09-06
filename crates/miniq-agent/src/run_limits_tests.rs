use super::*;
use miniq_models::mock::MockProvider;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[derive(Default)]
struct CountingExecutor {
    calls: AtomicUsize,
    cancel_after: Option<(usize, CancellationToken)>,
}

#[async_trait]
impl ToolExecutor for CountingExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        Vec::new()
    }

    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        let completed = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some((limit, cancel)) = &self.cancel_after {
            if completed == *limit {
                cancel.cancel();
            }
        }
        Ok(json!({"completed": call.arguments["index"]}))
    }
}

fn tool_turn(id: usize, index: usize) -> Vec<ChatDelta> {
    vec![ChatDelta::ToolCall(ToolCallRequest {
        id: format!("call-{id}"),
        name: "continue_work".into(),
        arguments: json!({"index": index}),
    })]
}

fn discard_events() -> tokio::sync::mpsc::Sender<AgentEvent> {
    let (events, _receiver) = tokio::sync::mpsc::channel(1);
    events
}

#[tokio::test]
async fn explicit_budgets_stop_before_an_extra_request_or_tool_execution() {
    for max_steps in [0, 1, 3, 96] {
        let provider = MockProvider::new(
            (0..=max_steps)
                .map(|index| tool_turn(index, index))
                .collect(),
        );
        let executor = CountingExecutor::default();
        let error = run_turn_with_limits(
            &provider,
            &executor,
            Vec::new(),
            discard_events(),
            CancellationToken::new(),
            RunLimits {
                max_steps: Some(max_steps),
                ..RunLimits::default()
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            AgentError::StepLimitExceeded { steps } if steps == max_steps
        ));
        assert!(error.to_string().contains("configured budget"));
        assert_eq!(provider.requests.lock().unwrap().len(), max_steps);
        assert_eq!(executor.calls.load(Ordering::SeqCst), max_steps);
    }
}

#[tokio::test]
async fn final_answer_on_the_last_budgeted_step_succeeds() {
    let provider = MockProvider::new(vec![tool_turn(0, 0), vec![ChatDelta::Text("done".into())]]);
    let executor = CountingExecutor::default();
    let outcome = run_turn_with_limits(
        &provider,
        &executor,
        Vec::new(),
        discard_events(),
        CancellationToken::new(),
        RunLimits {
            max_steps: Some(2),
            ..RunLimits::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(outcome.final_text, "done");
    assert_eq!(outcome.provider_history.len(), 3);
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retry_within_a_model_step_does_not_spend_another_step() {
    let provider = MockProvider::new(vec![Vec::new(), vec![ChatDelta::Text("done".into())]]);
    let outcome = run_turn_with_limits(
        &provider,
        &NoTools,
        Vec::new(),
        discard_events(),
        CancellationToken::new(),
        RunLimits {
            max_steps: Some(1),
            ..RunLimits::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(outcome.final_text, "done");
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn unbounded_turn_can_be_cancelled_after_96_steps() {
    let provider = MockProvider::new((0..101).map(|index| tool_turn(index, index)).collect());
    let cancel = CancellationToken::new();
    let executor = CountingExecutor {
        cancel_after: Some((100, cancel.clone())),
        ..CountingExecutor::default()
    };
    let error = run_turn(&provider, &executor, Vec::new(), discard_events(), cancel)
        .await
        .unwrap_err();

    assert!(matches!(error, AgentError::Cancelled));
    assert_eq!(executor.calls.load(Ordering::SeqCst), 100);
    assert_eq!(provider.requests.lock().unwrap().len(), 100);
}

#[tokio::test]
async fn repeated_call_guard_still_stops_loops_after_96_steps() {
    let mut turns: Vec<_> = (0..100).map(|index| tool_turn(index, index)).collect();
    turns.extend((100..104).map(|id| tool_turn(id, 100)));
    let provider = MockProvider::new(turns);
    let executor = CountingExecutor::default();
    let error = run_turn(
        &provider,
        &executor,
        Vec::new(),
        discard_events(),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        AgentError::RepeatedToolLoop { repetitions: 4 }
    ));
    assert_eq!(executor.calls.load(Ordering::SeqCst), 103);
    assert_eq!(provider.requests.lock().unwrap().len(), 104);
}

struct WaitingProvider {
    request_started: tokio::sync::Notify,
    waiting_for_stream: bool,
}

#[async_trait]
impl ModelProvider for WaitingProvider {
    async fn stream_complete(
        &self,
        _request: CompletionRequest,
    ) -> Result<miniq_models::DeltaStream, ProviderError> {
        self.request_started.notify_one();
        if self.waiting_for_stream {
            std::future::pending().await
        } else {
            Ok(Box::pin(futures_util::stream::pending()))
        }
    }

    fn describe(&self) -> String {
        "waiting test provider".into()
    }
}

#[tokio::test]
async fn unbounded_turn_can_be_cancelled_while_waiting_for_provider_or_stream() {
    for waiting_for_stream in [true, false] {
        let provider = WaitingProvider {
            request_started: tokio::sync::Notify::new(),
            waiting_for_stream,
        };
        let cancel = CancellationToken::new();
        let turn = run_turn(
            &provider,
            &NoTools,
            Vec::new(),
            discard_events(),
            cancel.clone(),
        );
        let stop = async {
            provider.request_started.notified().await;
            cancel.cancel();
        };
        let (result, ()) =
            tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(turn, stop) })
                .await
                .expect("cancellation must not wait for the provider");
        assert!(matches!(result, Err(AgentError::Cancelled)));
    }
}
