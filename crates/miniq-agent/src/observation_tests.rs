use super::*;
use miniq_models::{mock::MockProvider, ChatImage, ImageDetail};
use serde_json::json;

struct VisualExecutor;
#[async_trait]
impl ToolExecutor for VisualExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        Vec::new()
    }
    async fn execute(&self, _call: &ToolCallRequest) -> Result<Value, AgentError> {
        Ok(json!({"screenshot":{"id":"host-owned"}}))
    }
    fn result_images(&self, _call: &ToolCallRequest, _output: &Value) -> Vec<ChatImage> {
        vec![ChatImage {
            path: "host-owned.png".into(),
            mime_type: "image/png".into(),
            detail: ImageDetail::High,
        }]
    }
}

#[tokio::test]
async fn screenshots_reach_the_next_model_step_and_persist_in_history() {
    let provider = MockProvider::new(vec![
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "screen-1".into(),
            name: "computer_use".into(),
            arguments: json!({"action":"screenshot"}),
        })],
        vec![ChatDelta::Text("verified".into())],
    ]);
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let outcome = run_turn(
        &provider,
        &VisualExecutor,
        vec![ChatMessage::user("inspect")],
        tx,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let requests = provider.requests.lock().unwrap();
    let tool_result = requests[1]
        .messages
        .iter()
        .find(|message| message.tool_call_id.as_deref() == Some("screen-1"))
        .unwrap();
    assert_eq!(tool_result.images.len(), 1);
    assert!(!tool_result.content.contains("base64"));
    let persisted = outcome
        .provider_history
        .iter()
        .find(|message| message.tool_call_id.as_deref() == Some("screen-1"))
        .unwrap();
    assert_eq!(persisted.images, tool_result.images);
}
