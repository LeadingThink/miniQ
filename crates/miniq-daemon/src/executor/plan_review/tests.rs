use super::*;
use crate::state::AppState;
use miniq_models::{
    mock::MockProvider, ChatDelta, CompletionRequest, DeltaStream, ModelProvider, ProviderError,
};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

mod harness;
mod validation;
use harness::{decision, run_review};

#[tokio::test]
async fn completion_and_plan_updates_share_one_request_without_an_acknowledgement_turn() {
    let (_dir, executor) = fixture();
    let before = json!({"tasks":[task("research","completed"),task("video","in_progress")]});
    executor
        .execute(&call("task_update", before))
        .await
        .unwrap();
    let after = json!({"tasks":[task("research","completed"),task("video","completed")]});
    let provider = MockProvider::new(vec![vec![
        ChatDelta::ToolCall(call("task_update", after.clone())),
        decision("finished"),
    ]]);
    let mut events = executor.state.events.subscribe();
    let result = run_review(&executor, &provider).await.unwrap();
    assert_eq!(result.final_text, "The verified video is ready.");
    assert_eq!(
        json!(executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap()),
        after["tasks"]
    );
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].trace.purpose,
        miniq_models::ModelCallPurpose::CompletionReview
    );
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["task_update", "report_turn_completion"]
    );
    assert!(requests[0]
        .messages
        .last()
        .unwrap()
        .content
        .contains("never infer completion"));
    assert!(result.provider_history.iter().all(|message| {
        !message.content.contains("[miniQ completion review]")
            && !message
                .tool_calls
                .iter()
                .any(|call| call.name == "report_turn_completion" || call.name == "task_update")
    }));
    let mut updated = false;
    while let Ok(event) = events.try_recv() {
        if let miniq_protocol::Event::PlanUpdated {
            session_id, tasks, ..
        } = event
        {
            assert_eq!(session_id, executor.session_id);
            updated = tasks
                .iter()
                .all(|task| task.status == PlanTaskStatus::Completed);
        }
    }
    assert!(updated);
}

#[tokio::test]
async fn completed_empty_and_cancelled_plans_need_no_review_requests() {
    let (_dir, executor) = fixture();
    let provider = MockProvider::new(vec![]);
    run_review(&executor, &provider).await.unwrap();
    for tasks in [json!([]), json!([task("done", "completed")])] {
        executor
            .execute(&call("task_update", json!({"tasks":tasks})))
            .await
            .unwrap();
        run_review(&executor, &provider).await.unwrap();
        assert!(executor.plan_completion_review().is_none());
    }
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("pending","pending")]}),
        ))
        .await
        .unwrap();
    executor.cancel.cancel();
    assert!(executor.plan_completion_review().is_none());
    assert!(matches!(
        run_review(&executor, &provider).await,
        Err(AgentError::Cancelled)
    ));
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_missing_or_invalid_decisions_preserve_the_answer_and_progress() {
    let (_dir, executor) = fixture();
    let original = json!({"tasks":[task("video","in_progress")]});
    executor
        .execute(&call("task_update", original.clone()))
        .await
        .unwrap();
    let update = call("task_update", json!({"tasks":[task("video","completed")]}));
    for provider in [
        MockProvider::new(vec![]),
        MockProvider::text("No change"),
        MockProvider::new(vec![vec![decision("finished")]]),
        MockProvider::new(vec![vec![ChatDelta::ToolCall(update.clone())]]),
        MockProvider::new(vec![vec![
            ChatDelta::ToolCall(update),
            decision("finished"),
            decision("finished"),
        ]]),
    ] {
        let result = run_review(&executor, &provider).await.unwrap();
        assert_eq!(result.final_text, "The verified video is ready.");
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

struct WaitingProvider(tokio::sync::Notify);

#[async_trait]
impl ModelProvider for WaitingProvider {
    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        self.0.notify_one();
        std::future::pending().await
    }
    fn describe(&self) -> String {
        "waiting-test".into()
    }
}

#[tokio::test]
async fn cancellation_interrupts_bookkeeping_without_inventing_progress() {
    let (_dir, executor) = fixture();
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","in_progress")]}),
        ))
        .await
        .unwrap();
    let provider = WaitingProvider(tokio::sync::Notify::new());
    let stop = async {
        provider.0.notified().await;
        executor.cancel.cancel();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(run_review(&executor, &provider), stop)
    })
    .await
    .unwrap();
    assert!(matches!(result, Err(AgentError::Cancelled)));
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
    let result = run_review(&executor, &WaitingProvider(tokio::sync::Notify::new()))
        .await
        .unwrap();
    assert!(started.elapsed() >= Duration::from_secs(60));
    assert_eq!(result.final_text, "The verified video is ready.");
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
async fn an_invalid_review_cannot_execute_task_actions_or_create_a_review_loop() {
    let (dir, executor) = fixture();
    executor
        .execute(&call(
            "task_update",
            json!({"tasks":[task("video","pending")]}),
        ))
        .await
        .unwrap();
    let provider = MockProvider::new(vec![vec![
        ChatDelta::ToolCall(call(
            "file_write",
            json!({"path":"unexpected.txt","content":"side effect"}),
        )),
        decision("finished"),
    ]]);
    let result = run_review(&executor, &provider).await.unwrap();
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    assert!(!dir.path().join("unexpected.txt").exists());
    assert_eq!(result.final_text, "The verified video is ready.");
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
async fn image_history_review_preserves_reference_audit() {
    let (_directory, executor) = fixture();
    let review = ReviewExecutor {
        inner: &executor,
        plan: Vec::new(),
        source: ReviewPlan::Checklist,
    };
    review
        .record_history_read(
            &call("image_history", json!({"action":"read","ids":["img_1"]})),
            &json!({
                "image_references":["img_1"],
                "attached_image_references":["img_1"],
                "historical_evidence":true
            }),
        )
        .await
        .unwrap();
    let records = executor
        .state
        .store
        .list_tool_calls(&executor.session_id)
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].tool_name, "image_history");
    assert_eq!(records[0].status, miniq_protocol::ToolCallStatus::Succeeded);
    assert_eq!(
        executor
            .state
            .store
            .count_audit_events(&executor.session_id)
            .unwrap(),
        1
    );
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
