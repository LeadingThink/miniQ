use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct PlanExecutor {
    started: tokio::sync::Notify,
    attempts: AtomicUsize,
    stall: bool,
}

impl PlanExecutor {
    fn new(stall: bool) -> Self {
        Self {
            started: tokio::sync::Notify::new(),
            attempts: AtomicUsize::new(0),
            stall,
        }
    }
}

struct PlanUpdates<'a>(&'a PlanExecutor);

#[async_trait]
impl ToolExecutor for PlanUpdates<'_> {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "task_update".into(),
            description: "Reconcile this plan only".into(),
            parameters: json!({"type":"object"}),
        }]
    }

    async fn execute(&self, _: &ToolCallRequest) -> Result<Value, AgentError> {
        self.0.attempts.fetch_add(1, Ordering::SeqCst);
        self.0.started.notify_one();
        if self.0.stall {
            std::future::pending().await
        } else {
            Ok(json!({"ok":true}))
        }
    }
}

#[async_trait]
impl ToolExecutor for PlanExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        Vec::new()
    }

    fn completion_review(&self) -> Option<CompletionReview<'_>> {
        Some(CompletionReview {
            instructions: "Update verified plan progress in this review.".into(),
            executor: Box::new(PlanUpdates(self)),
        })
    }

    async fn execute(&self, _: &ToolCallRequest) -> Result<Value, AgentError> {
        panic!("a review must only use its restricted plan executor")
    }
}

fn review_deltas() -> Vec<ChatDelta> {
    let mut deltas = vec![ChatDelta::ToolCall(ToolCallRequest {
        id: "plan-update".into(),
        name: "task_update".into(),
        arguments: json!({"tasks":[]}),
    })];
    deltas.extend(verdict("finished"));
    deltas
}

#[tokio::test(start_paused = true)]
async fn timeout_also_bounds_bookkeeping_after_the_model_stream_finishes() {
    let provider = MockProvider::new(vec![review_deltas()]);
    let executor = PlanExecutor::new(true);
    let mut check = CompletionCheck::default();
    let started = tokio::time::Instant::now();
    assert!(check
        .instruction(
            &provider,
            &executor,
            &[],
            "Verified result",
            &None,
            1,
            &CancellationToken::new(),
        )
        .await
        .unwrap()
        .is_none());
    assert!(started.elapsed() >= REVIEW_TIMEOUT);
    assert_eq!(executor.attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_interrupts_bookkeeping_after_the_model_stream_finishes() {
    let provider = MockProvider::new(vec![review_deltas()]);
    let executor = PlanExecutor::new(true);
    let mut check = CompletionCheck::default();
    let cancel = CancellationToken::new();
    let context = None;
    let run = check.instruction(
        &provider,
        &executor,
        &[],
        "Verified result",
        &context,
        1,
        &cancel,
    );
    let stop = async {
        executor.started.notified().await;
        cancel.cancel();
    };
    let (result, ()) =
        tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(run, stop) })
            .await
            .unwrap();
    assert!(matches!(result, Err(AgentError::Cancelled)));
    assert_eq!(executor.attempts.load(Ordering::SeqCst), 1);
}

struct InvalidStreamProvider {
    error_after_finished: bool,
}

#[async_trait]
impl ModelProvider for InvalidStreamProvider {
    async fn stream_complete(
        &self,
        _: CompletionRequest,
    ) -> Result<miniq_models::DeltaStream, ProviderError> {
        let mut deltas = review_deltas().into_iter().map(Ok).collect::<Vec<_>>();
        if self.error_after_finished {
            deltas.push(Ok(ChatDelta::Finished));
            deltas.push(Err(ProviderError::IncompleteStream));
        }
        Ok(Box::pin(futures_util::stream::iter(deltas)))
    }

    fn describe(&self) -> String {
        "invalid-review-stream".into()
    }
}

#[tokio::test]
async fn incomplete_or_failed_streams_never_apply_buffered_plan_updates() {
    for error_after_finished in [false, true] {
        let provider = InvalidStreamProvider {
            error_after_finished,
        };
        let executor = PlanExecutor::new(false);
        let mut check = CompletionCheck::default();
        assert!(check
            .instruction(
                &provider,
                &executor,
                &[],
                "Verified result",
                &None,
                1,
                &CancellationToken::new(),
            )
            .await
            .unwrap()
            .is_none());
        assert_eq!(executor.attempts.load(Ordering::SeqCst), 0);
    }
}
