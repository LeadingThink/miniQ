use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct RetryProvider {
    calls: AtomicUsize,
    retry_after: Duration,
}

#[async_trait::async_trait]
impl ModelProvider for RetryProvider {
    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(ProviderError::Api {
                status: 503,
                body: "temporarily unavailable".into(),
                retry_after: Some(self.retry_after),
            });
        }
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ChatDelta::Text("recovered".into())),
            Ok(ChatDelta::Finished),
        ])))
    }
    fn describe(&self) -> String {
        "retry-test".into()
    }
}

#[tokio::test]
async fn child_retry_progress_is_scoped_and_cleared_on_completion_or_cancel() {
    for cancel in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let provider = Arc::new(RetryProvider {
            calls: AtomicUsize::new(0),
            retry_after: Duration::from_secs(if cancel { 60 } else { 0 }),
        });
        let bridge = bridge_with_provider(&directory, provider.clone());
        let mut input = request("test recovery");
        input.run_in_background = true;
        let id = bridge.run(input).await.unwrap()["agentId"]
            .as_str()
            .unwrap()
            .to_owned();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let list = bridge
                    .state
                    .agent_tasks
                    .list(&bridge.session_id)
                    .await
                    .unwrap();
                if list[0]["progress"]["phase"] == "waiting_retry" {
                    assert_eq!(list[0]["progress"]["retry"]["attempt"], 1);
                    assert_eq!(list[0]["progress"]["retry"]["maxAttempts"], 10);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(bridge
            .state
            .agent_tasks
            .list("another-session")
            .await
            .unwrap()
            .is_empty());
        assert!(bridge.state.turn_progress(&bridge.session_id).is_none());
        let result = if cancel {
            tokio::time::timeout(Duration::from_secs(1), bridge.stop(&id))
                .await
                .unwrap()
                .unwrap()
        } else {
            bridge
                .output(&id, true, Duration::from_secs(5))
                .await
                .unwrap()
        };
        assert_eq!(
            result["status"],
            if cancel { "cancelled" } else { "completed" }
        );
        assert!(result["progress"].is_null());
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            if cancel { 1 } else { 2 }
        );
    }
}
