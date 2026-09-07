use super::*;
use crate::state::AppState;
use miniq_models::{mock::MockProvider, ChatDelta, CompletionRequest, DeltaStream, ProviderError};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

mod validation;

fn fixture() -> (tempfile::TempDir, SessionToolExecutor) {
    let dir = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(dir.path().to_str().unwrap(), "test")
        .unwrap();
    let session = store.create_session(&workspace.id, "video").unwrap();
    let state = AppState::new(
        store,
        "test-token".into(),
        Arc::new(MockProvider::new(vec![])),
    );
    let ctx = miniq_tools::ToolContext::new(dir.path().into())
        .with_tasks(state.tasks.clone(), &session.id);
    let executor = SessionToolExecutor {
        router: state.router.clone(),
        state,
        ctx,
        session_id: session.id,
        cancel: CancellationToken::new(),
        permission_policy: super::super::PermissionPolicy::Inherit,
        review_plan: Default::default(),
    };
    (dir, executor)
}

fn call(name: &str, arguments: Value) -> ToolCallRequest {
    ToolCallRequest {
        id: format!("call-{name}"),
        name: name.into(),
        arguments,
    }
}

fn task(content: &str, status: &str) -> Value {
    json!({"content":content, "status":status})
}

fn outcome() -> TurnOutcome {
    TurnOutcome {
        final_text: "The verified 60-second video is ready.".into(),
        appended: vec![],
        provider_history: vec![
            ChatMessage::system("Complete the requested work."),
            ChatMessage::user("Create a video."),
            ChatMessage::assistant("The verified 60-second video is ready."),
        ],
    }
}

fn reviewer(executor: &SessionToolExecutor) -> ReviewExecutor<'_> {
    ReviewExecutor {
        inner: executor,
        plan: executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap(),
        source: executor.review_plan.lock().unwrap().clone().unwrap(),
    }
}

#[tokio::test]
async fn reconciles_two_of_five_and_preserves_the_delivered_answer() {
    let (_dir, executor) = fixture();
    let before = json!({"tasks":[task("inventory", "completed"), task("research", "completed"),
        task("storyboard", "in_progress"), task("screenshots", "pending"), task("video", "pending")]});
    executor
        .execute(&call("task_update", before.clone()))
        .await
        .unwrap();
    let after = json!({"tasks":[task("inventory", "completed"), task("research", "completed"),
        task("storyboard", "completed"), task("screenshots", "completed"), task("video", "completed")]});
    let provider = MockProvider::new(vec![
        vec![ChatDelta::ToolCall(call("task_update", after.clone()))],
        vec![ChatDelta::Text("Internal acknowledgement".into())],
    ]);
    let mut events = executor.state.events.subscribe();
    let mut result = outcome();
    executor
        .reconcile_plan(&provider, &mut result, ContextPolicy::default())
        .await;
    assert_eq!(result.final_text, outcome().final_text);
    assert_eq!(
        json!(executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap()),
        after["tasks"]
    );
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|request| request.tools.len() == 1 && request.tools[0].name == "task_update"));
    assert!(requests[0]
        .messages
        .last()
        .unwrap()
        .content
        .contains("never infer completion"));
    assert!(result
        .provider_history
        .iter()
        .any(|message| message.tool_call_id.is_some()));
    let mut updated = false;
    while let Ok(event) = events.try_recv() {
        if let miniq_protocol::Event::PlanUpdated { session_id, tasks } = event {
            assert_eq!(session_id, executor.session_id);
            updated = tasks
                .iter()
                .all(|task| task.status == PlanTaskStatus::Completed);
        }
    }
    assert!(updated);
}

#[tokio::test]
async fn native_checklists_can_leave_unverified_work_pending() {
    let (_dir, executor) = fixture();
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","in_progress")]}),
        ))
        .await
        .unwrap();
    let review = reviewer(&executor);
    let result = review
        .execute(&call(
            "TodoWrite",
            json!({"todos":[{"content":"video","status":"pending","activeForm":"Checking video"}]}),
        ))
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(
        executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap()[0]
            .status,
        PlanTaskStatus::Pending
    );
    review
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","completed")]}),
        ))
        .await
        .unwrap();
    assert!(review
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","pending")]})
        ))
        .await
        .unwrap()
        .get("error")
        .is_some());
}

#[tokio::test]
async fn completed_empty_and_cancelled_plans_need_no_provider_requests() {
    let (_dir, executor) = fixture();
    let provider = MockProvider::new(vec![]);
    executor
        .reconcile_plan(&provider, &mut outcome(), ContextPolicy::default())
        .await;
    for tasks in [json!([]), json!([task("done", "completed")])] {
        executor
            .execute(&call("task_update", json!({"tasks":tasks})))
            .await
            .unwrap();
        executor
            .reconcile_plan(&provider, &mut outcome(), ContextPolicy::default())
            .await;
    }
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("pending","pending")]}),
        ))
        .await
        .unwrap();
    executor.cancel.cancel();
    executor
        .reconcile_plan(&provider, &mut outcome(), ContextPolicy::default())
        .await;
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn provider_failure_or_missing_update_preserves_the_answer_and_real_progress() {
    let (_dir, executor) = fixture();
    let original = json!({"tasks":[task("video","in_progress")]});
    executor
        .execute(&call("task_update", original.clone()))
        .await
        .unwrap();
    for provider in [MockProvider::new(vec![]), MockProvider::text("No change")] {
        let mut result = outcome();
        executor
            .reconcile_plan(&provider, &mut result, ContextPolicy::default())
            .await;
        assert_eq!(result.final_text, outcome().final_text);
        assert_eq!(
            json!(executor
                .state
                .store
                .session_plan(&executor.session_id)
                .unwrap()),
            original["tasks"]
        );
    }
}

struct WaitingProvider;

#[async_trait]
impl ModelProvider for WaitingProvider {
    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        std::future::pending().await
    }
    fn describe(&self) -> String {
        "waiting-test".into()
    }
}

#[tokio::test]
async fn cancelling_bookkeeping_is_prompt_and_does_not_discard_the_deliverable() {
    let (_dir, executor) = fixture();
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","in_progress")]}),
        ))
        .await
        .unwrap();
    let cancel = executor.cancel.clone();
    let mut result = outcome();
    let review = executor.reconcile_plan(&WaitingProvider, &mut result, ContextPolicy::default());
    let stop = async move {
        tokio::task::yield_now().await;
        cancel.cancel();
    };
    tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(review, stop);
    })
    .await
    .unwrap();
    assert_eq!(result.final_text, outcome().final_text);
    assert_eq!(
        executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap()[0]
            .status,
        PlanTaskStatus::InProgress
    );
}

#[tokio::test(start_paused = true)]
async fn a_stalled_review_times_out_without_losing_the_answer() {
    let (_dir, executor) = fixture();
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","pending")]}),
        ))
        .await
        .unwrap();
    let started = tokio::time::Instant::now();
    let mut result = outcome();
    executor
        .reconcile_plan(&WaitingProvider, &mut result, ContextPolicy::default())
        .await;
    assert!(started.elapsed() >= REVIEW_TIMEOUT);
    assert_eq!(result.final_text, outcome().final_text);
    assert_eq!(
        executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap()[0]
            .status,
        PlanTaskStatus::Pending
    );
}

#[tokio::test]
async fn a_model_that_ignores_review_instructions_cannot_loop_forever() {
    let (_dir, executor) = fixture();
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","pending")]}),
        ))
        .await
        .unwrap();
    let provider = MockProvider::new(
        (0..3)
            .map(|index| {
                vec![ChatDelta::ToolCall(call(
                    "shell_run",
                    json!({"command":format!("echo {index}")}),
                ))]
            })
            .collect(),
    );
    let mut result = outcome();
    executor
        .reconcile_plan(&provider, &mut result, ContextPolicy::default())
        .await;
    assert_eq!(provider.requests.lock().unwrap().len(), 3);
    assert_eq!(
        executor
            .state
            .store
            .list_tool_calls(&executor.session_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(result.final_text, outcome().final_text);
}

#[tokio::test]
async fn review_does_not_leak_into_another_sessions_plan() {
    let (_dir, executor) = fixture();
    let session = executor
        .state
        .store
        .get_session(&executor.session_id)
        .unwrap();
    let other = executor
        .state
        .store
        .create_session(&session.workspace_id, "other")
        .unwrap();
    let original = vec![PlanTask {
        content: "other work".into(),
        status: PlanTaskStatus::InProgress,
    }];
    executor
        .state
        .store
        .set_session_plan(&other.id, &original)
        .unwrap();
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","pending")]}),
        ))
        .await
        .unwrap();
    reviewer(&executor)
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","completed")]}),
        ))
        .await
        .unwrap();
    assert_eq!(
        json!(executor.state.store.session_plan(&other.id).unwrap()),
        json!(original)
    );
}
