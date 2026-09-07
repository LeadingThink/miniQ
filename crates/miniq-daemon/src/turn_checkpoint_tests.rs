use super::*;
use async_trait::async_trait;
use miniq_models::{
    ChatDelta, CompletionRequest, DeltaStream, ModelProvider, ProviderError, ToolCallRequest,
};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

struct ScriptedProvider {
    turns: Mutex<VecDeque<Result<Vec<ChatDelta>, ProviderError>>>,
    requests: Mutex<Vec<CompletionRequest>>,
    cancel: CancellationToken,
}

#[async_trait]
impl ModelProvider for ScriptedProvider {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        self.requests.lock().unwrap().push(request);
        let turn = self.turns.lock().unwrap().pop_front().unwrap();
        if turn.is_err() {
            self.cancel.cancel();
            return std::future::pending().await;
        }
        Ok(Box::pin(futures_util::stream::iter(
            turn?.into_iter().map(Ok),
        )))
    }
    fn describe(&self) -> String {
        "checkpoint-test".into()
    }
}

#[tokio::test]
async fn cancelled_turn_keeps_tools_partial_output_plan_and_latest_request() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("result.txt"), "confirmed result").unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "resume").unwrap();
    let other = store.create_session(&workspace.id, "isolated").unwrap();
    store
        .append_message(&session.id, Role::User, "old task")
        .unwrap();
    let plan: Vec<miniq_protocol::PlanTask> = serde_json::from_value(json!([{"content":"read result", "status":"completed"}, {"content":"old remaining work", "status":"pending"}])).unwrap();
    store.set_session_plan(&session.id, &plan).unwrap();
    let cancel = CancellationToken::new();
    let provider = Arc::new(ScriptedProvider {
        requests: Default::default(),
        cancel: cancel.clone(),
        turns: Mutex::new(VecDeque::from([
            Ok(vec![
                ChatDelta::Text("I checked the file".into()),
                ChatDelta::ToolCall(ToolCallRequest {
                    id: "read-1".into(),
                    name: "file_read".into(),
                    arguments: json!({"path":"result.txt"}),
                }),
            ]),
            Err(ProviderError::Config("cancel after tool".into())),
            Ok(vec![ChatDelta::Text("answer to the new question".into())]),
        ])),
    });
    let state = AppState::new(store, "test-token".into(), provider.clone());
    let mut events = state.events.subscribe();
    assert!(matches!(
        execute_turn(&state, &session.id, cancel).await,
        Err(TurnError::Cancelled)
    ));
    let mut visible = Vec::new();
    while let Ok(event) = events.try_recv() {
        if matches!(
            event,
            Event::AssistantDelta { .. } | Event::MessageCreated { .. }
        ) {
            visible.push(event);
        }
    }
    assert!(matches!(visible.last(), Some(Event::MessageCreated { .. })));
    let snapshot = state.store.get_model_context(&session.id).unwrap().unwrap();
    let history: Vec<ChatMessage> = serde_json::from_value(snapshot.history).unwrap();
    assert!(history
        .iter()
        .any(|message| message.tool_call_id.as_deref() == Some("read-1")
            && message.content.contains("confirmed result")));
    assert_eq!(state.store.session_plan(&session.id).unwrap().len(), 2);
    assert!(state
        .store
        .list_messages(&session.id)
        .unwrap()
        .iter()
        .any(|message| message.content.contains("I checked the file")));
    assert!(state.store.get_model_context(&other.id).unwrap().is_none());
    state
        .store
        .append_message(
            &session.id,
            Role::User,
            "new question, do not continue old work",
        )
        .unwrap();
    assert!(execute_turn(&state, &session.id, CancellationToken::new())
        .await
        .is_ok());
    let requests = provider.requests.lock().unwrap();
    let request = requests.last().unwrap();
    assert!(request.messages[0].content.contains("old remaining work"));
    assert_eq!(
        request.messages.last().unwrap().content,
        "new question, do not continue old work"
    );
    assert!(request
        .messages
        .iter()
        .any(|message| message.tool_call_id.as_deref() == Some("read-1")));
    assert_eq!(state.store.list_tool_calls(&session.id).unwrap().len(), 1);
}
