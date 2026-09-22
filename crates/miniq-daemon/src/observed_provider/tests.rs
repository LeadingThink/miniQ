use super::*;
use futures_util::{stream, StreamExt};
use miniq_models::ChatMessage;
use miniq_protocol::{ApiProtocol, ModelCallsParams, ProviderResponseInfo};
use serde_json::json;

struct FixtureProvider {
    fail: bool,
    wait: bool,
}

#[async_trait]
impl ModelProvider for FixtureProvider {
    fn describe(&self) -> String {
        "fixture".into()
    }
    async fn execution_info(
        &self,
        max_output_tokens: Option<u32>,
    ) -> Result<Option<ModelExecutionInfo>, ProviderError> {
        Ok(Some(ModelExecutionInfo {
            model: "requested-model".into(),
            api_protocol: ApiProtocol::Responses,
            reasoning_effort: None,
            max_output_tokens,
        }))
    }
    async fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            max_output_tokens: Some(128_000),
            ..Default::default()
        }
    }
    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        if self.wait {
            std::future::pending::<()>().await;
        }
        if self.fail {
            return Err(ProviderError::Api {
                status: 503,
                body: json!({"error":"busy", "api_key":"test-secret"}).to_string(),
                retry_after: None,
            });
        }
        Ok(Box::pin(stream::iter(vec![
            Ok(ChatDelta::ResponseInfo(ProviderResponseInfo {
                model: Some("actual-model".into()),
                usage: Some(
                    json!({"input_tokens":20,"output_tokens":0,"output_tokens_details":{"cached":3}}),
                ),
                ..Default::default()
            })),
            Ok(ChatDelta::ResponseInfo(ProviderResponseInfo {
                usage: Some(
                    json!({"output_tokens":100,"output_tokens_details":{"reasoning_tokens":90}}),
                ),
                ..Default::default()
            })),
            Ok(ChatDelta::Finished),
        ])))
    }
}

fn fixture(fail: bool, wait: bool) -> (ObservedProvider, ModelCallsParams) {
    fixture_with_provider(Arc::new(FixtureProvider { fail, wait }))
}

fn fixture_with_provider(inner: Arc<dyn ModelProvider>) -> (ObservedProvider, ModelCallsParams) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let workspace = store.create_workspace("/fixture", "fixture").unwrap();
    let session = store.create_session(&workspace.id, "fixture").unwrap();
    let params = ModelCallsParams {
        session_id: session.id.clone(),
        agent_id: None,
        before: None,
        limit: 20,
    };
    let provider = ObservedProvider::new(
        inner,
        store,
        session.id,
        Some("child-1".into()),
        "turn-1".into(),
        None,
    );
    (provider, params)
}

struct SwitchingProtocolProvider {
    started: std::sync::atomic::AtomicBool,
    fail_refresh: bool,
}

#[async_trait]
impl ModelProvider for SwitchingProtocolProvider {
    fn describe(&self) -> String {
        "switching protocol fixture".into()
    }

    async fn execution_info(
        &self,
        max_output_tokens: Option<u32>,
    ) -> Result<Option<ModelExecutionInfo>, ProviderError> {
        let started = self.started.load(std::sync::atomic::Ordering::SeqCst);
        if started && self.fail_refresh {
            return Err(ProviderError::Config("metadata unavailable".into()));
        }
        Ok(Some(ModelExecutionInfo {
            model: "requested-model".into(),
            api_protocol: if started {
                ApiProtocol::ChatCompletions
            } else {
                ApiProtocol::Responses
            },
            reasoning_effort: None,
            max_output_tokens,
        }))
    }

    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        self.started
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(Box::pin(stream::iter(vec![
            Ok(ChatDelta::Text("completed after negotiation".into())),
            Ok(ChatDelta::Finished),
        ])))
    }
}

fn request() -> CompletionRequest {
    CompletionRequest {
        trace: Default::default(),
        messages: vec![ChatMessage::user("private prompt")],
        tools: vec![],
        temperature: None,
        max_output_tokens: None,
    }
}

#[tokio::test]
async fn persists_real_usage_without_converting_capabilities_to_request_limits() {
    let (provider, params) = fixture(false, false);
    let mut stream = provider.stream_complete(request()).await.unwrap();
    while stream.next().await.is_some() {}
    drop(stream);
    let page = provider.store.model_calls_page(&params).unwrap();
    let record = &page.calls[0];
    assert_eq!(record.status, ModelCallStatus::Completed);
    assert_eq!(record.agent_id.as_deref(), Some("child-1"));
    assert_eq!(record.request.as_ref().unwrap().max_output_tokens, None);
    assert_eq!(record.advertised_output_tokens, Some(128_000));
    assert_eq!(record.response.model.as_deref(), Some("actual-model"));
    assert_eq!(
        record.response.usage.as_ref().unwrap(),
        &json!({"input_tokens":20,"output_tokens":100,"output_tokens_details":{"cached":3,"reasoning_tokens":90}})
    );
    assert!(!serde_json::to_string(record)
        .unwrap()
        .contains("private prompt"));
}

#[tokio::test]
async fn records_the_protocol_selected_when_the_stream_is_established() {
    let (provider, params) = fixture_with_provider(Arc::new(SwitchingProtocolProvider {
        started: Default::default(),
        fail_refresh: false,
    }));
    let mut completion = request();
    completion.max_output_tokens = Some(4096);
    let mut stream = provider.stream_complete(completion).await.unwrap();
    let page = provider.store.model_calls_page(&params).unwrap();
    let execution = page.calls[0].request.as_ref().unwrap();
    assert_eq!(execution.api_protocol, ApiProtocol::ChatCompletions);
    assert_eq!(execution.max_output_tokens, Some(4096));
    assert_eq!(page.calls[0].status, ModelCallStatus::Running);
    while stream.next().await.is_some() {}
    assert_eq!(
        provider.store.model_calls_page(&params).unwrap().calls[0].status,
        ModelCallStatus::Completed
    );
}

#[tokio::test]
async fn unavailable_refreshed_metadata_does_not_discard_a_valid_stream() {
    let (provider, params) = fixture_with_provider(Arc::new(SwitchingProtocolProvider {
        started: Default::default(),
        fail_refresh: true,
    }));
    let mut stream = provider.stream_complete(request()).await.unwrap();
    assert!(matches!(
        stream.next().await,
        Some(Ok(ChatDelta::Text(text))) if text == "completed after negotiation"
    ));
    assert!(matches!(stream.next().await, Some(Ok(ChatDelta::Finished))));
    let page = provider.store.model_calls_page(&params).unwrap();
    let record = &page.calls[0];
    assert_eq!(record.status, ModelCallStatus::Completed);
    assert_eq!(
        record.request.as_ref().unwrap().api_protocol,
        ApiProtocol::Responses
    );
    assert_eq!(record.error, None);
}

#[tokio::test]
async fn failed_request_redacts_credentials_and_keeps_usage_unknown() {
    let (provider, params) = fixture(true, false);
    assert!(provider.stream_complete(request()).await.is_err());
    let page = provider.store.model_calls_page(&params).unwrap();
    let record = &page.calls[0];
    assert_eq!(record.status, ModelCallStatus::Failed);
    assert_eq!(record.response.usage, None);
    assert!(!record.error.as_ref().unwrap().contains("test-secret"));
    assert!(record.error.as_ref().unwrap().contains("busy"));
}

#[tokio::test]
async fn cancellation_before_headers_and_during_stream_is_durable() {
    let (provider, params) = fixture(false, true);
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        provider.stream_complete(request())
    )
    .await
    .is_err());
    assert_eq!(
        provider.store.model_calls_page(&params).unwrap().calls[0].status,
        ModelCallStatus::Interrupted
    );
    let (provider, params) = fixture(false, false);
    let stream = provider.stream_complete(request()).await.unwrap();
    drop(stream);
    let record = provider
        .store
        .model_calls_page(&params)
        .unwrap()
        .calls
        .remove(0);
    assert_eq!(record.status, ModelCallStatus::Interrupted);
    assert!(record.elapsed_ms.is_some());
}

#[tokio::test]
async fn pages_are_stable_scoped_and_recover_running_records_on_restart() {
    let (provider, mut params) = fixture(false, false);
    for _ in 0..5 {
        drop(provider.stream_complete(request()).await.unwrap());
    }
    params.limit = 2;
    let mut ids = std::collections::HashSet::new();
    loop {
        let page = provider.store.model_calls_page(&params).unwrap();
        for record in page.calls {
            assert!(ids.insert(record.id));
        }
        params.before = page.next_cursor;
        if params.before.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 5);
    params.agent_id = Some("other-child".into());
    assert!(provider
        .store
        .model_calls_page(&params)
        .unwrap()
        .calls
        .is_empty());
    params.agent_id = None;
    params.session_id = "other-session".into();
    assert!(provider
        .store
        .model_calls_page(&params)
        .unwrap()
        .calls
        .is_empty());
    params.session_id = provider.session_id.clone();
    let stream = provider.stream_complete(request()).await.unwrap();
    provider.store.recover_interrupted_work().unwrap();
    assert!(provider
        .store
        .model_calls_page(&params)
        .unwrap()
        .calls
        .iter()
        .all(|call| call.status == ModelCallStatus::Interrupted));
    drop(stream);
}
