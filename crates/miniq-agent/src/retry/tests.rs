use super::*;
use crate::{run_turn, ToolExecutor};
use async_trait::async_trait;
use miniq_models::{
    ChatDelta, ChatMessage, CompletionRequest, DeltaStream, ModelProvider, ToolCallRequest,
    ToolSpec,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

type Attempt = Result<Vec<Result<ChatDelta, ProviderError>>, ProviderError>;
struct Scripted {
    attempts: Mutex<VecDeque<Attempt>>,
    requests: Mutex<Vec<CompletionRequest>>,
}
impl Scripted {
    fn new(attempts: Vec<Attempt>) -> Self {
        Self {
            attempts: Mutex::new(attempts.into()),
            requests: Mutex::new(Vec::new()),
        }
    }
}
#[async_trait]
impl ModelProvider for Scripted {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        self.requests.lock().unwrap().push(request);
        let deltas = self
            .attempts
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra model request")?;
        Ok(Box::pin(futures_util::stream::iter(deltas)))
    }
    fn describe(&self) -> String {
        "retry-test".into()
    }
}
struct Writes(AtomicUsize);
#[async_trait]
impl ToolExecutor for Writes {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "file_write".into(),
            description: "test".into(),
            parameters: json!({"type":"object"}),
        }]
    }
    async fn execute(&self, _: &ToolCallRequest) -> Result<Value, AgentError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"written":true}))
    }
}
fn unavailable() -> ProviderError {
    ProviderError::Api {
        status: 503,
        body: "temporary overload".into(),
        retry_after: Some(Duration::ZERO),
    }
}
fn finished() -> Attempt {
    Ok(vec![
        Ok(ChatDelta::Text("done".into())),
        Ok(ChatDelta::Finished),
    ])
}

#[tokio::test]
async fn request_failures_retry_the_current_step_and_never_repeat_completed_tools() {
    let tool = ToolCallRequest {
        id: "write-1".into(),
        name: "file_write".into(),
        arguments: json!({}),
    };
    let provider = Scripted::new(vec![
        Ok(vec![Ok(ChatDelta::ToolCall(tool)), Ok(ChatDelta::Finished)]),
        Err(unavailable()),
        finished(),
    ]);
    let executor = Writes(AtomicUsize::new(0));
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    assert_eq!(
        run_turn(
            &provider,
            &executor,
            vec![ChatMessage::user("work")],
            tx,
            CancellationToken::new()
        )
        .await
        .unwrap()
        .final_text,
        "done"
    );
    assert_eq!(executor.0.load(Ordering::SeqCst), 1);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        serde_json::to_value(&requests[1].messages).unwrap(),
        serde_json::to_value(&requests[2].messages).unwrap()
    );
    let mut retried = false;
    while let Ok(event) = rx.try_recv() {
        if let AgentEvent::ModelRetryScheduled { step, attempt, .. } = event {
            assert_eq!((step, attempt), (2, 1));
            retried = true;
        }
    }
    assert!(retried);
}

#[tokio::test(start_paused = true)]
async fn interrupted_responses_retry_without_executing_uncommitted_tools_or_context() {
    let provider = Scripted::new(vec![Ok(vec![Err(unavailable())]), finished()]);
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    assert!(run_turn(
        &provider,
        &crate::NoTools,
        vec![],
        tx,
        CancellationToken::new()
    )
    .await
    .is_ok());
    for output in [
        ChatDelta::Text("partial text".into()),
        ChatDelta::ToolCall(ToolCallRequest {
            id: "w".into(),
            name: "file_write".into(),
            arguments: json!({}),
        }),
        ChatDelta::Context(miniq_models::ProviderContext {
            protocol: miniq_models::ApiProtocol::Responses,
            data: json!([{"type":"reasoning", "encrypted_content":"opaque-test-context"}]),
        }),
    ] {
        let provider = Scripted::new(vec![Ok(vec![Ok(output), Err(unavailable())]), finished()]);
        let writes = Writes(AtomicUsize::new(0));
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let outcome = run_turn(&provider, &writes, vec![], tx, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(outcome.final_text, "done");
        assert_eq!(provider.requests.lock().unwrap().len(), 2);
        assert_eq!(writes.0.load(Ordering::SeqCst), 0);
        let mut displayed = String::new();
        while let Ok(event) = rx.try_recv() {
            match event {
                AgentEvent::TextDelta(text) => displayed.push_str(&text),
                AgentEvent::TextReplaced(text) => displayed = text,
                _ => {}
            }
        }
        assert_eq!(displayed, "done");
        assert!(outcome
            .provider_history
            .last()
            .unwrap()
            .provider_context
            .is_none());
    }
}

#[tokio::test(start_paused = true)]
async fn overloaded_partial_output_restores_previous_steps_and_retries_only_the_current_request() {
    let provider = Scripted::new(vec![
        Ok(vec![Ok(ChatDelta::Text("Verified work".into())), Ok(ChatDelta::ToolCall(ToolCallRequest {
            id: "write".into(), name: "file_write".into(), arguments: json!({}),
        })), Ok(ChatDelta::Finished)]),
        Ok(vec![Ok(ChatDelta::Text("Unfinished response".into())), Err(ProviderError::Transient(
            "Responses API error: Our servers are currently overloaded. Please try again later.".into()
        ))]),
        finished(),
    ]);
    let writes = Writes(AtomicUsize::new(0));
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let outcome = run_turn(&provider, &writes, vec![], tx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(outcome.final_text, "done");
    assert_eq!(writes.0.load(Ordering::SeqCst), 1);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        serde_json::to_value(&requests[1].messages).unwrap(),
        serde_json::to_value(&requests[2].messages).unwrap()
    );
    let mut displayed = String::new();
    let mut replaced = false;
    while let Ok(event) = rx.try_recv() {
        match event {
            AgentEvent::TextDelta(text) => displayed.push_str(&text),
            AgentEvent::TextReplaced(text) => {
                assert_eq!(text, "Verified work");
                replaced = true;
                displayed = text;
            }
            _ => {}
        }
    }
    assert!(replaced);
    assert_eq!(displayed, "Verified work\n\ndone");
}

#[tokio::test]
async fn emitted_whitespace_is_not_replayed_as_an_empty_completion() {
    let provider = Scripted::new(vec![Ok(vec![
        Ok(ChatDelta::Text(" \n".into())),
        Ok(ChatDelta::Finished),
    ])]);
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let error = run_turn(
        &provider,
        &crate::NoTools,
        vec![],
        tx,
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("empty completion after 1 attempts"));
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn retry_after_is_a_minimum_without_disabling_exponential_backoff() {
    for (attempts, hint_secs, minimum_ms) in [(0, 0, 1000), (2, 1, 4000), (0, 9, 9000)] {
        let error = ProviderError::Api {
            status: 429,
            body: "rate limit".into(),
            retry_after: Some(Duration::from_secs(hint_secs)),
        };
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(async move {
            let mut retries = ModelRetries::new(4);
            retries.attempts = attempts;
            retries.wait(&error, 1, &tx, &cancel).await
        });
        let AgentEvent::ModelRetryScheduled { delay_ms, .. } = rx.recv().await.unwrap() else {
            panic!("expected retry progress");
        };
        assert!((minimum_ms..minimum_ms + 250).contains(&delay_ms));
        stop.cancel();
        assert!(matches!(task.await.unwrap(), Err(AgentError::Cancelled)));
    }
}

#[tokio::test(start_paused = true)]
async fn permanent_stream_errors_are_not_retried_and_transient_retries_are_bounded() {
    let provider = Scripted::new(vec![Ok(vec![Err(ProviderError::InvalidResponse(
        "invalid tools".into(),
    ))])]);
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    assert!(run_turn(
        &provider,
        &crate::NoTools,
        vec![],
        tx,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    let provider = Scripted::new((0..11).map(|_| Err(unavailable())).collect());
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    assert!(run_turn(
        &provider,
        &crate::NoTools,
        vec![],
        tx,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(provider.requests.lock().unwrap().len(), 11);
    let mut attempts = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let AgentEvent::ModelRetryScheduled {
            attempt,
            max_attempts,
            ..
        } = event
        {
            assert_eq!(max_attempts, 10);
            attempts.push(attempt);
        }
    }
    assert_eq!(attempts, (1..=10).collect::<Vec<_>>());
}

#[tokio::test(start_paused = true)]
async fn the_tenth_retry_can_recover_without_repeating_a_completed_tool() {
    let mut attempts = vec![Ok(vec![
        Ok(ChatDelta::ToolCall(ToolCallRequest {
            id: "write-once".into(),
            name: "file_write".into(),
            arguments: json!({}),
        })),
        Ok(ChatDelta::Finished),
    ])];
    attempts.extend((0..10).map(|_| Err(unavailable())));
    attempts.push(finished());
    let provider = Scripted::new(attempts);
    let executor = Writes(AtomicUsize::new(0));
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    let outcome = run_turn(&provider, &executor, vec![], tx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(outcome.final_text, "done");
    assert_eq!(executor.0.load(Ordering::SeqCst), 1);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 12);
    for request in &requests[2..] {
        assert_eq!(
            serde_json::to_value(&request.messages).unwrap(),
            serde_json::to_value(&requests[1].messages).unwrap()
        );
    }
}

#[tokio::test]
async fn a_retry_wait_can_be_cancelled_immediately() {
    let error = ProviderError::Api {
        status: 429,
        body: "temporary rate limit".into(),
        retry_after: Some(Duration::from_secs(60)),
    };
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let task =
        tokio::spawn(async move { ModelRetries::new(4).wait(&error, 1, &tx, &cancel).await });
    let event = rx.recv().await.unwrap();
    assert!(
        matches!(event, AgentEvent::ModelRetryScheduled { delay_ms, .. } if delay_ms >= 60_000)
    );
    stop.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap(),
        Err(AgentError::Cancelled)
    ));
}

#[tokio::test]
async fn long_server_hints_and_exhausted_time_budgets_do_not_trigger_early_retries() {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let error = ProviderError::Api {
        status: 503,
        body: "busy".into(),
        retry_after: Some(Duration::from_secs(600)),
    };
    let mut retries = ModelRetries::new(4);
    assert!(!retries
        .wait(&error, 1, &tx, &CancellationToken::new())
        .await
        .unwrap());
    retries.started = Some(Instant::now() - Duration::from_secs(301));
    assert!(!retries
        .wait(&unavailable(), 1, &tx, &CancellationToken::new())
        .await
        .unwrap());
    assert!(rx.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn compaction_retries_transient_requests_and_discards_partial_summaries() {
    let policy = crate::ContextPolicy {
        soft_limit_tokens: 8,
        preserve_recent_messages: 1,
        summary_batch_tokens: 1000,
        ..crate::ContextPolicy::default()
    };
    for partial in [false, true] {
        let attempts = if partial {
            vec![
                Ok(vec![
                    Ok(ChatDelta::Text("partial".into())),
                    Err(unavailable()),
                ]),
                finished(),
            ]
        } else {
            vec![Err(unavailable()), Ok(vec![Err(unavailable())]), finished()]
        };
        let provider = Scripted::new(attempts);
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let result = crate::compact_history(
            &provider,
            vec![
                ChatMessage::user("old request"),
                ChatMessage::assistant("old answer"),
                ChatMessage::user("continue"),
            ],
            &[],
            &policy,
            4,
            &tx,
            &CancellationToken::new(),
        )
        .await;
        let result = result.unwrap();
        assert!(result.compacted);
        assert!(!serde_json::to_string(&result.messages)
            .unwrap()
            .contains("partial"));
        assert_eq!(
            provider.requests.lock().unwrap().len(),
            if partial { 2 } else { 3 }
        );
        assert!(matches!(
            rx.try_recv().unwrap(),
            AgentEvent::ModelRetryScheduled {
                step: 0,
                attempt: 1,
                ..
            }
        ));
    }
}
