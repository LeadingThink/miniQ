use super::*;
use miniq_models::{ChatDelta, DeltaStream, ModelProvider, ProviderError};
use miniq_protocol::SessionStatus;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Notify;
use tokio_tungstenite::{connect_async, tungstenite::Message};

struct GatedProvider {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait::async_trait]
impl ModelProvider for GatedProvider {
    async fn stream_complete(
        &self,
        _request: miniq_models::CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        self.started.notify_one();
        self.release.notified().await;
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ChatDelta::Text("task survived".into())),
            Ok(ChatDelta::Finished),
        ])))
    }

    fn describe(&self) -> String {
        "gated cancellation test".into()
    }
}

#[tokio::test]
async fn cancelling_a_request_and_closing_its_socket_do_not_stop_a_model_task() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "test")
        .unwrap();
    let session = store
        .create_session(&workspace.id, "existing task")
        .unwrap();
    let state = AppState::new(
        store,
        "fixture".into(),
        Arc::new(GatedProvider {
            started: started.clone(),
            release: release.clone(),
        }),
    );
    let listener = bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_state = state.clone();
    let server = tokio::spawn(async move { serve(listener, server_state).await.unwrap() });
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/ws?token=fixture"))
        .await
        .unwrap();
    socket
        .send(Message::text(
            json!({
                "jsonrpc":"2.0", "id":"task", "method":"session.sendMessage",
                "params":{"sessionId":session.id,"message":{"role":"user","content":"hi"}}
            })
            .to_string(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .expect("model started");
    assert_eq!(
        state.store.get_session(&session.id).unwrap().status,
        SessionStatus::Running
    );

    socket
        .send(Message::text(
            json!({
                "jsonrpc":"2.0", "method":"request.cancel", "params":{"requestId":"task"}
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket
        .send(Message::text(
            json!({
                "jsonrpc":"2.0", "id":"barrier", "method":"daemon.health"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
                continue;
            };
            let response: Value = serde_json::from_str(&text).unwrap();
            // Notifications have no response, including cancellation of a
            // request which is intentionally outside the cancellable set.
            assert!(response.get("error").is_none(), "{response}");
            if response["id"] == "barrier" {
                break;
            }
        }
    })
    .await
    .expect("health response after cancellation notification");
    socket.close(None).await.unwrap();
    drop(socket);
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if state.store.get_session(&session.id).unwrap().status == SessionStatus::Idle {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("model task completed after disconnection");
    let messages = state.store.list_messages(&session.id).unwrap();
    assert!(messages
        .iter()
        .any(|message| message.content == "task survived"));
    state.shutdown.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}
