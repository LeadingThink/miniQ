use super::*;
use miniq_models::{ChatDelta, CompletionRequest, DeltaStream, ModelProvider, ProviderError};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
struct InterruptedProvider {
    attempts: AtomicUsize,
    ready: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl ModelProvider for InterruptedProvider {
    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        let deltas = if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            self.ready.notified().await;
            vec![Ok(ChatDelta::Text("Interrupted".into())), Err(ProviderError::Transient("Responses API error: Our servers are currently overloaded. Please try again later.".into()))]
        } else {
            vec![
                Ok(ChatDelta::Text("Recovered answer".into())),
                Ok(ChatDelta::Finished),
            ]
        };
        Ok(Box::pin(futures_util::stream::iter(deltas)))
    }
    fn describe(&self) -> String {
        "interrupted-test".into()
    }
}

#[tokio::test]
async fn partial_overload_recovers_over_the_live_rpc_stream_without_a_failed_turn() {
    let provider = Arc::new(InterruptedProvider::default());
    let (port, token) = start_daemon_with(provider.clone()).await;
    let mut socket = connect(port, &token).await;
    let directory = tempfile::tempdir().unwrap();
    let workspace = call(
        &mut socket,
        "workspace",
        "workspace.open",
        json!({"path":directory.path()}),
    )
    .await;
    let session = call(
        &mut socket,
        "session",
        "session.create",
        json!({"workspaceId":workspace["result"]["id"]}),
    )
    .await;
    let id = session["result"]["id"].as_str().unwrap();
    call(
        &mut socket,
        "send",
        "session.sendMessage",
        json!({"sessionId":id,"message":{"role":"user","content":"work"}}),
    )
    .await;
    provider.ready.notify_one();
    let mut displayed = String::new();
    let mut replaced = false;
    let mut retried = false;
    loop {
        let raw = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(raw) = raw else { continue };
        let event: Value = serde_json::from_str(&raw).unwrap();
        match event["type"].as_str() {
            Some("assistant_delta") => displayed.push_str(event["delta"].as_str().unwrap()),
            Some("assistant_replaced") => {
                assert_eq!(displayed, "Interrupted");
                displayed = event["text"].as_str().unwrap().to_string();
                replaced = true;
            }
            Some("turn_progress_changed") if event["progress"]["phase"] == "waiting_retry" => {
                assert_eq!(event["progress"]["retry"]["maxAttempts"], 10);
                retried = true;
            }
            Some("turn_failed") => panic!("transient response should recover: {event}"),
            Some("turn_completed") => break,
            _ => {}
        }
    }
    assert!(replaced && retried);
    assert_eq!(displayed, "Recovered answer");
    assert_eq!(provider.attempts.load(Ordering::SeqCst), 2);
    let reopened = call(&mut socket, "open", "session.open", json!({"sessionId":id})).await;
    assert_eq!(reopened["result"]["session"]["status"], "idle");
    assert_eq!(
        reopened["result"]["messages"][1]["content"],
        "Recovered answer"
    );
    assert_eq!(reopened["result"]["messages"].as_array().unwrap().len(), 2);
    assert_eq!(reopened["result"]["streamingText"], "");
}
