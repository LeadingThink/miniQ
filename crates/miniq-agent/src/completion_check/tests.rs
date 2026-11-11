use super::*;
use crate::{run_turn_with_limits, RunLimits, ToolExecutor};
use async_trait::async_trait;
use miniq_models::{mock::MockProvider, ToolCallRequest};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

mod interim;

#[derive(Default)]
struct Executor(Mutex<Vec<String>>);

#[async_trait]
impl ToolExecutor for Executor {
    fn should_verify_completion(&self) -> bool {
        true
    }

    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "work".into(),
            description: "Execute one authorized action".into(),
            parameters: json!({"type":"object"}),
        }]
    }

    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        self.0.lock().unwrap().push(call.id.clone());
        Ok(json!({"ok":true,"action":call.id}))
    }
}

struct OrdinaryExecutor;

#[async_trait]
impl ToolExecutor for OrdinaryExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "work".into(),
            description: "Execute one ordinary action".into(),
            parameters: json!({"type":"object"}),
        }]
    }

    async fn execute(&self, _: &ToolCallRequest) -> Result<Value, AgentError> {
        Ok(json!({"ok":true}))
    }
}

fn work(id: &str) -> Vec<ChatDelta> {
    vec![ChatDelta::ToolCall(ToolCallRequest {
        id: id.into(),
        name: "work".into(),
        arguments: json!({}),
    })]
}

fn answer(text: &str) -> Vec<ChatDelta> {
    vec![ChatDelta::Text(text.into())]
}

fn verdict(status: &str) -> Vec<ChatDelta> {
    vec![ChatDelta::ToolCall(ToolCallRequest {
        id: "review".into(),
        name: TOOL.into(),
        arguments: json!({"status":status,"reason":"Only inspection ran; merging remains authorized."}),
    })]
}

fn limits() -> RunLimits {
    RunLimits {
        verify_completion: true,
        max_model_retries: 0,
        ..RunLimits::default()
    }
}

#[tokio::test]
async fn a_text_only_promise_without_a_checklist_continues_without_repeating_work() {
    let provider = MockProvider::new(vec![
        work("inspect"),
        answer("核对通过。现在合并。"),
        verdict("continue"),
        work("merge"),
        answer("已合并，并验证了结果。"),
        verdict("finished"),
    ]);
    let executor = Executor::default();
    let user = "请核对并合并这个 PR。";
    let (events, _) = tokio::sync::mpsc::channel(64);
    let outcome = run_turn_with_limits(
        &provider,
        &executor,
        vec![ChatMessage::user(user)],
        events,
        CancellationToken::new(),
        limits(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.final_text, "已合并，并验证了结果。");
    assert_eq!(*executor.0.lock().unwrap(), ["inspect", "merge"]);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 6);
    assert_eq!(
        requests[2].trace.purpose,
        ModelCallPurpose::CompletionReview
    );
    assert_eq!(requests[2].tools.len(), 1);
    assert_eq!(requests[2].tools[0].name, TOOL);
    assert!(requests[3].messages.iter().any(|m| m.content == user));
    assert!(requests[3]
        .messages
        .iter()
        .any(|m| m.role == ChatRole::Tool && m.tool_call_id.as_deref() == Some("inspect")));
    assert!(requests[3]
        .messages
        .last()
        .unwrap()
        .content
        .contains("[miniQ turn completion check]"));
    assert!(!outcome
        .provider_history
        .iter()
        .any(|m| m.content.contains(POLICY)));
}

#[tokio::test]
async fn finished_and_blocked_answers_end_without_another_task_request() {
    for status in ["finished", "blocked"] {
        let provider =
            MockProvider::new(vec![work("inspect"), answer("结果说明"), verdict(status)]);
        let executor = Executor::default();
        let (events, _) = tokio::sync::mpsc::channel(32);
        let outcome = run_turn_with_limits(
            &provider,
            &executor,
            vec![ChatMessage::user("检查结果，缺少权限时停止。")],
            events,
            CancellationToken::new(),
            limits(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.final_text, "结果说明");
        assert_eq!(provider.requests.lock().unwrap().len(), 3);
        assert_eq!(*executor.0.lock().unwrap(), ["inspect"]);
    }
}

#[tokio::test]
async fn plain_chat_internal_jobs_and_disabled_callers_do_not_request_a_review() {
    for (turns, purpose, enabled) in [
        (vec![answer("解释")], ModelCallPurpose::Task, true),
        (
            vec![work("inspect"), answer("结果")],
            ModelCallPurpose::PlanReview,
            true,
        ),
        (
            vec![work("inspect"), answer("结果")],
            ModelCallPurpose::Task,
            false,
        ),
    ] {
        let count = turns.len();
        let provider = MockProvider::new(turns);
        let (events, _) = tokio::sync::mpsc::channel(32);
        run_turn_with_limits(
            &provider,
            &Executor::default(),
            vec![ChatMessage::user("说明")],
            events,
            CancellationToken::new(),
            RunLimits {
                purpose,
                verify_completion: enabled,
                ..limits()
            },
        )
        .await
        .unwrap();
        assert_eq!(provider.requests.lock().unwrap().len(), count);
    }
}

#[tokio::test]
async fn reviews_preserve_native_context_and_do_not_modify_the_transcript() {
    let provider = MockProvider::new(vec![verdict("finished")]);
    let context = Some(ProviderContext {
        protocol: miniq_models::ApiProtocol::Responses,
        data: json!([{"type":"message","role":"assistant","content":[]}]),
    });
    let history = vec![
        ChatMessage::system("Host policy"),
        ChatMessage::user("核对"),
    ];
    let before = serde_json::to_value(&history).unwrap();
    let mut check = CompletionCheck::default();
    assert!(check
        .instruction(
            &provider,
            &history,
            "已完成",
            &context,
            2,
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .is_none());
    assert_eq!(serde_json::to_value(&history).unwrap(), before);
    let requests = provider.requests.lock().unwrap();
    let candidate = &requests[0].messages[history.len()];
    assert_eq!(candidate.provider_context, context);
    assert_eq!(candidate.content, "已完成");
}

#[tokio::test]
async fn invalid_or_missing_decisions_cannot_dispatch_task_tools_or_discard_the_answer() {
    let invalid = vec![ChatDelta::ToolCall(ToolCallRequest {
        id: "invalid".into(),
        name: TOOL.into(),
        arguments: json!({"status":"continue","reason":"next","unexpected":true}),
    })];
    for review in [
        answer("not a decision"),
        work("unauthorized"),
        invalid,
        vec![],
    ] {
        let provider = MockProvider::new(vec![work("inspect"), answer("结果保留"), review]);
        let executor = Executor::default();
        let (events, _) = tokio::sync::mpsc::channel(32);
        let outcome = run_turn_with_limits(
            &provider,
            &executor,
            vec![ChatMessage::user("检查")],
            events,
            CancellationToken::new(),
            limits(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.final_text, "结果保留");
        assert_eq!(*executor.0.lock().unwrap(), ["inspect"]);
    }
}

#[tokio::test]
async fn unfinished_work_cannot_loop_past_the_continuation_budget() {
    let provider = MockProvider::new(
        (0..=MAX_CONTINUATIONS)
            .map(|_| verdict("continue"))
            .collect(),
    );
    let mut check = CompletionCheck::default();
    for _ in 0..MAX_CONTINUATIONS {
        assert!(check
            .instruction(
                &provider,
                &[],
                "现在处理",
                &None,
                1,
                &CancellationToken::new()
            )
            .await
            .unwrap()
            .is_some());
        check.record_continuation().unwrap();
    }
    assert!(matches!(
        check.record_continuation(),
        Err(AgentError::CompletionCheckLimitExceeded {
            continuations: MAX_CONTINUATIONS
        })
    ));
}

#[tokio::test]
async fn cancellation_prevents_a_review_request() {
    let provider = MockProvider::new(vec![]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut check = CompletionCheck::default();
    assert!(matches!(
        check
            .instruction(&provider, &[], "结果", &None, 1, &cancel)
            .await,
        Err(AgentError::Cancelled)
    ));
    assert!(provider.requests.lock().unwrap().is_empty());
}

struct PendingProvider;

#[async_trait]
impl ModelProvider for PendingProvider {
    async fn stream_complete(
        &self,
        _request: CompletionRequest,
    ) -> Result<miniq_models::DeltaStream, ProviderError> {
        std::future::pending().await
    }

    fn describe(&self) -> String {
        "pending".into()
    }
}

#[tokio::test(start_paused = true)]
async fn a_review_timeout_preserves_the_existing_answer() {
    let mut check = CompletionCheck::default();
    assert!(check
        .instruction(
            &PendingProvider,
            &[],
            "结果",
            &None,
            1,
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .is_none());
}

#[derive(Debug, Default)]
struct Checkpoints(Mutex<Vec<crate::TurnCheckpoint>>);

#[async_trait]
impl crate::CheckpointStore for Checkpoints {
    async fn save(&self, checkpoint: crate::TurnCheckpoint) -> Result<(), AgentError> {
        self.0.lock().unwrap().push(checkpoint);
        Ok(())
    }
}

#[tokio::test]
async fn continuation_is_checkpointed_before_the_next_side_effect() {
    let provider = MockProvider::new(vec![
        work("inspect"),
        answer("现在合并"),
        verdict("continue"),
        work("merge"),
        answer("已完成"),
        verdict("finished"),
    ]);
    let checkpoints = Arc::new(Checkpoints::default());
    let (events, _) = tokio::sync::mpsc::channel(64);
    run_turn_with_limits(
        &provider,
        &Executor::default(),
        vec![ChatMessage::user("检查并合并")],
        events,
        CancellationToken::new(),
        RunLimits {
            checkpoint: Some(checkpoints.clone()),
            ..limits()
        },
    )
    .await
    .unwrap();
    assert!(checkpoints.0.lock().unwrap().iter().any(|saved| {
        saved
            .history
            .last()
            .is_some_and(|m| m.content.contains("[miniQ turn completion check]"))
            && !saved
                .history
                .iter()
                .any(|m| m.tool_calls.iter().any(|c| c.id == "merge"))
    }));
}

#[tokio::test]
async fn ordinary_tool_turns_do_not_request_a_completion_review() {
    let provider = MockProvider::new(vec![work("inspect"), answer("已检查")]);
    let (events, _) = tokio::sync::mpsc::channel(32);
    let outcome = run_turn_with_limits(
        &provider,
        &OrdinaryExecutor,
        vec![ChatMessage::user("检查这个文件")],
        events,
        CancellationToken::new(),
        RunLimits {
            verify_completion: true,
            ..RunLimits::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(outcome.final_text, "已检查");
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}

struct GatedExecutor {
    work: Executor,
    pending: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl ToolExecutor for GatedExecutor {
    fn should_verify_completion(&self) -> bool {
        true
    }

    fn specs(&self) -> Vec<ToolSpec> {
        self.work.specs()
    }

    async fn completion_gate(&self, _cancel: &CancellationToken) -> Option<String> {
        self.pending
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |pending| pending.checked_sub(1),
            )
            .is_ok()
            .then(|| "Collect the running process first.".into())
    }

    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        self.work.execute(call).await
    }
}

#[tokio::test]
async fn an_existing_unfinished_work_gate_runs_before_semantic_review() {
    let provider = MockProvider::new(vec![
        work("launch"),
        answer("中间结果"),
        work("collect"),
        answer("已完成"),
        verdict("finished"),
    ]);
    let executor = GatedExecutor {
        work: Executor::default(),
        pending: std::sync::atomic::AtomicUsize::new(1),
    };
    let (events, _) = tokio::sync::mpsc::channel(64);
    let outcome = run_turn_with_limits(
        &provider,
        &executor,
        vec![ChatMessage::user("完成任务")],
        events,
        CancellationToken::new(),
        limits(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.final_text, "已完成");
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests[2].trace.purpose, ModelCallPurpose::Task);
    assert_eq!(
        requests[4].trace.purpose,
        ModelCallPurpose::CompletionReview
    );
    assert_eq!(*executor.work.0.lock().unwrap(), ["launch", "collect"]);
}

#[tokio::test]
async fn host_continuations_do_not_consume_the_semantic_budget() {
    let mut turns = vec![work("launch"), answer("等待结果")];
    turns.extend((0..MAX_CONTINUATIONS).flat_map(|_| [answer("现在继续"), verdict("continue")]));
    turns.extend([answer("已完成"), verdict("finished")]);
    let provider = MockProvider::new(turns);
    let executor = GatedExecutor {
        work: Executor::default(),
        pending: std::sync::atomic::AtomicUsize::new(1),
    };
    let (events, _) = tokio::sync::mpsc::channel(128);
    let outcome = run_turn_with_limits(
        &provider,
        &executor,
        vec![ChatMessage::user("完成任务")],
        events,
        CancellationToken::new(),
        limits(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.final_text, "已完成");
    assert_eq!(*executor.work.0.lock().unwrap(), ["launch"]);
}

#[tokio::test]
async fn pending_task_collection_can_exceed_the_semantic_budget() {
    let mut turns = vec![work("launch")];
    turns.extend((0..=MAX_CONTINUATIONS + 1).map(|_| answer("收集结果")));
    turns.push(verdict("finished"));
    let provider = MockProvider::new(turns);
    let executor = GatedExecutor {
        work: Executor::default(),
        pending: std::sync::atomic::AtomicUsize::new(MAX_CONTINUATIONS + 1),
    };
    let (events, _) = tokio::sync::mpsc::channel(128);
    let outcome = run_turn_with_limits(
        &provider,
        &executor,
        vec![ChatMessage::user("完成并收集后台任务")],
        events,
        CancellationToken::new(),
        limits(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.final_text, "收集结果");
    assert_eq!(*executor.work.0.lock().unwrap(), ["launch"]);
}

#[tokio::test]
async fn cancellation_interrupts_a_review_that_is_already_waiting() {
    let cancel = CancellationToken::new();
    let pending_cancel = cancel.clone();
    let cancel_task = tokio::spawn(async move {
        tokio::task::yield_now().await;
        pending_cancel.cancel();
    });
    let mut check = CompletionCheck::default();
    assert!(matches!(
        check
            .instruction(&PendingProvider, &[], "结果", &None, 1, &cancel)
            .await,
        Err(AgentError::Cancelled)
    ));
    cancel_task.await.unwrap();
}
