use super::*;
use async_trait::async_trait;
use miniq_models::{ApiProtocol, DeltaStream, ProviderContext, ToolCallRequest};
use serde_json::json;
use std::{collections::VecDeque, sync::Mutex};

type Attempt = Vec<Result<ChatDelta, ProviderError>>;
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
        let attempt = self
            .attempts
            .lock()
            .unwrap()
            .pop_front()
            .expect("extra request");
        Ok(Box::pin(futures_util::stream::iter(attempt)))
    }

    fn describe(&self) -> String {
        "summary-test".into()
    }
}

fn unexpected_tool() -> Result<ChatDelta, ProviderError> {
    Ok(ChatDelta::ToolCall(ToolCallRequest {
        id: "do-not-execute".into(),
        name: "file_write".into(),
        arguments: json!({"path":"/tmp/must-not-be-written"}),
    }))
}

#[test]
fn transcript_preserves_visible_facts_but_never_serializes_native_reasoning() {
    let mut assistant = ChatMessage::assistant("Created report; tests pending.");
    assistant.tool_calls.push(ToolCallRequest {
        id: "call-1".into(),
        name: "file_read".into(),
        arguments: json!({"path":"/work/报告.md"}),
    });
    let mut user = ChatMessage::user("Keep all 2000 records.");
    user.images.push(miniq_models::ChatImage {
        path: "/work/reference.png".into(),
        mime_type: "image/png".into(),
        detail: Default::default(),
    });
    for protocol in [
        ApiProtocol::AnthropicMessages,
        ApiProtocol::Responses,
        ApiProtocol::ChatCompletions,
    ] {
        assistant.provider_context = Some(ProviderContext {
            protocol,
            data: json!({"thinking":"private-thought", "signature":"opaque-signature"}),
        });
        let history = vec![
            user.clone(),
            assistant.clone(),
            ChatMessage::tool_result("call-1", "row\n".repeat(2000)),
        ];
        let serialized = transcript(&history).unwrap();
        let entries: Vec<ChatMessage> = serde_json::from_str(&serialized).unwrap();
        for (original, entry) in history.iter().zip(entries) {
            assert_eq!(entry.role, original.role);
            assert_eq!(entry.content, original.content);
            assert_eq!(entry.images, original.images);
            assert_eq!(entry.tool_calls, original.tool_calls);
            assert_eq!(entry.tool_call_id, original.tool_call_id);
            assert!(entry.provider_context.is_none());
        }
        assert!(!serialized.contains("private-thought"));
        assert!(!serialized.contains("opaque-signature"));
        assert!(history[1].provider_context.is_some());
    }
}

#[tokio::test(start_paused = true)]
async fn tool_attempt_is_discarded_and_retried_as_text_without_replaying_the_call() {
    let provider = Scripted::new(vec![
        vec![
            Ok(ChatDelta::Text("invalid partial".into())),
            unexpected_tool(),
        ],
        vec![unexpected_tool()],
        vec![
            Ok(ChatDelta::Text("Report ready; tests pending.".into())),
            Ok(ChatDelta::Finished),
        ],
    ]);
    let (tx, _) = tokio::sync::mpsc::channel(32);
    let result = summarize_batch(
        &provider,
        &[ChatMessage::user("history")],
        2,
        &tx,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result, "Report ready; tests pending.");
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].messages[0]
        .content
        .contains("previous summary attempt"));
    assert_eq!(
        requests[1].messages[0].content,
        requests[2].messages[0].content
    );
    for (index, request) in requests.iter().enumerate() {
        assert!(request.tools.is_empty());
        assert_eq!(request.trace.attempt, index + 1);
        assert_eq!(request.messages.len(), 2);
        assert!(!request.messages[1].content.contains("do-not-execute"));
    }
}

#[tokio::test(start_paused = true)]
async fn repeated_tool_attempts_obey_the_retry_limit() {
    let provider = Scripted::new(vec![vec![unexpected_tool()], vec![unexpected_tool()]]);
    let (tx, _) = tokio::sync::mpsc::channel(32);
    let error = summarize_batch(&provider, &[], 1, &tx, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        AgentError::ModelRetryStopped { attempts: 1, .. }
    ));
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn refusal_is_reported_without_ten_identical_retries() {
    let provider = Scripted::new(vec![vec![Err(ProviderError::Refusal)]]);
    let (tx, _) = tokio::sync::mpsc::channel(32);
    let error = summarize_batch(&provider, &[], 10, &tx, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        AgentError::Provider(ProviderError::Refusal)
    ));
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn unfinished_summary_is_never_used_as_a_checkpoint() {
    let provider = Scripted::new(vec![
        vec![Ok(ChatDelta::Text("unfinished".into()))],
        vec![
            Ok(ChatDelta::Text("complete".into())),
            Ok(ChatDelta::Finished),
        ],
    ]);
    let (tx, _) = tokio::sync::mpsc::channel(32);
    assert_eq!(
        summarize_batch(&provider, &[], 1, &tx, &CancellationToken::new())
            .await
            .unwrap(),
        "complete"
    );
}

#[tokio::test]
async fn output_limit_is_not_retried_with_the_same_transcript() {
    let provider = Scripted::new(vec![vec![Err(ProviderError::OutputLimitReached(
        miniq_models::OutputTokenUsage::default(),
    ))]]);
    let (tx, _) = tokio::sync::mpsc::channel(32);
    let error = summarize_batch(
        &provider,
        &[ChatMessage::user("history")],
        10,
        &tx,
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        error,
        AgentError::Provider(ProviderError::OutputLimitReached(_))
    ));
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}
