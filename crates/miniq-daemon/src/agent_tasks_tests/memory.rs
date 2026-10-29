use super::*;
use miniq_models::{ProviderConfig, ProviderContext, ToolCallRequest};
use miniq_protocol::{ApiProtocol, MemoryDeleteParams, MemoryTarget, MemoryWriteParams};
use serde_json::json;

#[tokio::test]
async fn resumed_child_drops_forgotten_memory_and_private_context_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::text("continued"));
    let mut bridge = bridge_with_provider(&directory, provider.clone());
    let config = ProviderConfig {
        base_url: "https://test.invalid/v1".into(),
        api_key: "test".into(),
        model: "test-model".into(),
        api_protocol: ApiProtocol::Responses,
        reasoning_effort: None,
    };
    bridge.state.settings.lock().unwrap().provider = Some(config.clone());
    let input: MemoryWriteParams = serde_json::from_value(json!({
        "target":{"scope":"global"},"content":"FORGOTTEN_MEMORY_FACT"
    }))
    .unwrap();
    let row = bridge
        .state
        .store
        .write_memory(&input, None)
        .unwrap()
        .memory
        .unwrap();
    let manager = bridge.state.agent_tasks.clone();
    let (id, record) = manager
        .create(
            &bridge.session_id,
            None,
            &request("inspect"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut history = vec![ChatMessage::system("child")];
    manager
        .bind_model_context(
            &record,
            &mut history,
            crate::memory::context_identity(
                crate::session_models::model_identity(Some(&config)),
                bridge.state.store.memory_generation().unwrap(),
            ),
        )
        .await
        .unwrap();
    let mut call = ChatMessage::assistant("");
    call.tool_calls.push(ToolCallRequest {
        id: "read".into(),
        name: "memory_read".into(),
        arguments: json!({"target":{"scope":"global"},"id":row.id}),
    });
    history.push(call);
    history.push(ChatMessage::tool_result(
        "read",
        json!({"memory":row}).to_string(),
    ));
    let mut answer = ChatMessage::assistant("record inspected");
    answer.provider_context = Some(ProviderContext {
        protocol: ApiProtocol::Responses,
        data: json!({"encrypted":"old-private-state"}),
    });
    history.push(answer);
    manager
        .finish_turn(&record, "record inspected".into(), history)
        .await
        .unwrap();
    manager.complete(&record).await.unwrap();
    let stored = bridge
        .state
        .store
        .agent_history(&bridge.session_id, &id)
        .unwrap()
        .unwrap();
    assert!(!stored.to_string().contains("FORGOTTEN_MEMORY_FACT"));
    assert!(stored.to_string().contains("old-private-state"));
    bridge
        .state
        .store
        .delete_memory(&MemoryDeleteParams {
            target: MemoryTarget::Global {},
            id: row.id,
            expected_content: row.content,
            expected_updated_at: row.updated_at,
        })
        .unwrap();
    bridge.state.agent_tasks = Arc::new(AgentTaskManager::new(bridge.state.store.clone()));
    let mut resume = request("continue");
    resume.resume = Some(id);
    bridge.run(resume).await.unwrap();
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0]
        .messages
        .iter()
        .all(|m| m.provider_context.is_none()));
    assert!(!serde_json::to_string(&requests[0].messages)
        .unwrap()
        .contains("FORGOTTEN_MEMORY_FACT"));
    assert!(requests[0]
        .messages
        .iter()
        .any(|m| m.content == "record inspected"));
}
