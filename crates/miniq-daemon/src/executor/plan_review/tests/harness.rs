use super::*;
use miniq_agent::{run_turn_with_limits, RunLimits, TurnOutcome};
use miniq_models::{ChatMessage, ModelCallPurpose, ModelProvider};

/// Exercise the real turn runner while exposing only its review request to the
/// scripted provider. The preceding read is real, harmless and session-scoped.
struct TaskThenReview<'a> {
    review: &'a dyn ModelProvider,
    text: &'a str,
}

#[async_trait]
impl ModelProvider for TaskThenReview<'_> {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        if request.trace.purpose != ModelCallPurpose::Task {
            return self.review.stream_complete(request).await;
        }
        let provider = if request.trace.step == Some(1) {
            MockProvider::new(vec![vec![ChatDelta::ToolCall(call(
                "file_list",
                json!({"path":"."}),
            ))]])
        } else {
            MockProvider::text(self.text)
        };
        provider.stream_complete(request).await
    }

    fn describe(&self) -> String {
        "task-then-review".into()
    }
}

pub(super) async fn run_review(
    executor: &SessionToolExecutor,
    provider: &dyn ModelProvider,
) -> Result<TurnOutcome, AgentError> {
    let provider = TaskThenReview {
        review: provider,
        text: "The verified video is ready.",
    };
    let (events, _) = tokio::sync::mpsc::channel(64);
    run_turn_with_limits(
        &provider,
        executor,
        vec![
            ChatMessage::system("Complete the requested work."),
            ChatMessage::user("Create a video."),
        ],
        events,
        executor.cancel.clone(),
        RunLimits {
            verify_completion: true,
            max_model_retries: 0,
            ..RunLimits::default()
        },
    )
    .await
}

pub(super) fn decision(status: &str) -> ChatDelta {
    ChatDelta::ToolCall(call(
        "report_turn_completion",
        json!({
            "status":status, "reason":"Use the verified task evidence and current constraints."
        }),
    ))
}
