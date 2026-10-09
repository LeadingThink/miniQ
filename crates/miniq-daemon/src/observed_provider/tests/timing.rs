use super::*;
use miniq_models::ToolCallRequest;

struct TimingProvider {
    text: bool,
    fail: bool,
}

#[async_trait]
impl ModelProvider for TimingProvider {
    fn describe(&self) -> String {
        "timing fixture".into()
    }

    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        let mut items = vec![
            Ok(ChatDelta::FirstEvent(Instant::now())),
            Ok(ChatDelta::ResponseInfo(ProviderResponseInfo::default())),
            Ok(ChatDelta::Text(String::new())),
            Ok(ChatDelta::ToolCall(ToolCallRequest {
                id: "tool-1".into(),
                name: "file_read".into(),
                arguments: json!({"path":"README.md"}),
            })),
        ];
        if self.text {
            items.extend([
                Ok(ChatDelta::Text("首段".into())),
                Ok(ChatDelta::Text("后续正文".into())),
            ]);
        }
        items.push(if self.fail {
            Err(ProviderError::Transient("stream interrupted".into()))
        } else {
            Ok(ChatDelta::Finished)
        });
        Ok(Box::pin(stream::iter(items)))
    }
}

fn latest(provider: &ObservedProvider, params: &ModelCallsParams) -> ModelCallRecord {
    provider
        .store
        .model_calls_page(params)
        .unwrap()
        .calls
        .remove(0)
}

#[tokio::test]
async fn timings_are_durable_while_running_and_do_not_count_metadata_or_tools_as_text() {
    let (provider, params) = fixture_with_provider(Arc::new(TimingProvider {
        text: true,
        fail: false,
    }));
    let mut stream = provider.stream_complete(request()).await.unwrap();
    let ready = latest(&provider, &params);
    assert!(ready.stream_ready_ms.is_some());
    assert_eq!(ready.first_event_ms, None);
    assert_eq!(ready.first_text_ms, None);
    assert!(matches!(
        stream.next().await,
        Some(Ok(ChatDelta::FirstEvent(_)))
    ));
    let event = latest(&provider, &params);
    assert!(event.first_event_ms.is_some());
    for _ in 0..3 {
        stream.next().await.unwrap().unwrap();
        assert_eq!(latest(&provider, &params).first_text_ms, None);
    }
    stream.next().await.unwrap().unwrap();
    let first_text = latest(&provider, &params);
    assert_eq!(first_text.status, ModelCallStatus::Running);
    assert!(first_text.first_text_ms.unwrap() >= event.first_event_ms.unwrap());
    stream.next().await.unwrap().unwrap();
    assert_eq!(
        latest(&provider, &params).first_text_ms,
        first_text.first_text_ms
    );
    stream.next().await.unwrap().unwrap();
    let finished = latest(&provider, &params);
    assert_eq!(finished.status, ModelCallStatus::Completed);
    assert!(finished.elapsed_ms.unwrap() >= finished.first_text_ms.unwrap());
}

#[tokio::test]
async fn tool_only_requests_have_event_timing_and_no_text_timing() {
    let (provider, params) = fixture_with_provider(Arc::new(TimingProvider {
        text: false,
        fail: false,
    }));
    let mut stream = provider.stream_complete(request()).await.unwrap();
    while stream.next().await.is_some() {}
    let record = latest(&provider, &params);
    assert_eq!(record.status, ModelCallStatus::Completed);
    assert!(record.first_event_ms.is_some());
    assert_eq!(record.first_text_ms, None);
}

#[tokio::test]
async fn stream_failures_and_cancellation_preserve_observed_timings() {
    for fail in [false, true] {
        let (provider, params) =
            fixture_with_provider(Arc::new(TimingProvider { text: true, fail }));
        let mut stream = provider.stream_complete(request()).await.unwrap();
        for _ in 0..5 {
            stream.next().await.unwrap().unwrap();
        }
        let before = latest(&provider, &params);
        if fail {
            while stream.next().await.is_some() {}
        }
        drop(stream);
        let after = latest(&provider, &params);
        assert_eq!(
            after.status,
            if fail {
                ModelCallStatus::Failed
            } else {
                ModelCallStatus::Interrupted
            }
        );
        assert_eq!(after.first_event_ms, before.first_event_ms);
        assert_eq!(after.first_text_ms, before.first_text_ms);
        assert!(after.elapsed_ms.unwrap() >= after.first_text_ms.unwrap());
    }
}
