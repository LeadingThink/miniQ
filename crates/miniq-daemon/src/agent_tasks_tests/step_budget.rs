use super::*;
use miniq_models::ToolCallRequest;

fn progress_turn(index: usize) -> Vec<ChatDelta> {
    vec![ChatDelta::ToolCall(ToolCallRequest {
        id: format!("plan-{index}"),
        name: "task_update".into(),
        arguments: serde_json::json!({
            "tasks": [{"content": format!("step {index}"), "status": "pending"}]
        }),
    })]
}

#[tokio::test]
async fn child_agents_keep_the_default_and_explicit_step_budgets() {
    for (max_turns, expected_steps) in [(None, 32), (Some(2), 2)] {
        let directory = tempfile::tempdir().unwrap();
        let provider = Arc::new(MockProvider::new(
            (0..=expected_steps).map(progress_turn).collect(),
        ));
        let bridge = bridge_with_provider(&directory, provider.clone());
        let mut request = request("bounded work");
        request.max_turns = max_turns;

        let result = bridge.run(request).await.unwrap();

        assert_eq!(result["status"], "failed");
        assert_eq!(
            result["error"],
            format!("agent exhausted its configured budget of {expected_steps} model steps")
        );
        assert_eq!(provider.requests.lock().unwrap().len(), expected_steps);
        let calls = bridge
            .state
            .store
            .list_tool_calls(&bridge.session_id)
            .unwrap();
        assert_eq!(calls.len(), expected_steps);
        assert!(calls
            .iter()
            .all(|call| call.status == miniq_protocol::ToolCallStatus::Succeeded));
    }
}

#[tokio::test]
async fn child_agent_can_finish_on_its_last_allowed_step() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::new(vec![
        progress_turn(0),
        vec![ChatDelta::Text("done".into())],
    ]));
    let bridge = bridge_with_provider(&directory, provider.clone());
    let mut request = request("bounded work");
    request.max_turns = Some(2);

    let result = bridge.run(request).await.unwrap();

    assert_eq!(result["status"], "completed");
    assert_eq!(result["result"], "done");
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}
