use super::*;
use miniq_models::{ModelCallPurpose, ToolCallRequest};

fn progress_turn(index: usize) -> Vec<ChatDelta> {
    vec![ChatDelta::ToolCall(ToolCallRequest {
        id: format!("plan-{index}"),
        name: "task_update".into(),
        arguments: serde_json::json!({
            "tasks": [{"content": format!("step {index}"), "status": "completed"}]
        }),
    })]
}

#[tokio::test]
async fn child_agents_complete_beyond_96_steps_in_foreground_and_background() {
    for background in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let mut turns: Vec<_> = (0..100).map(progress_turn).collect();
        turns.push(vec![ChatDelta::Text("done".into())]);
        let provider = Arc::new(MockProvider::new(turns));
        let bridge = bridge_with_provider(&directory, provider.clone());
        let mut input = request("long delegated task");
        input.run_in_background = background;
        let started = bridge.run(input).await.unwrap();
        let id = started["agentId"].as_str().unwrap();
        let result = bridge
            .output(id, true, Duration::from_secs(30))
            .await
            .unwrap();

        assert_eq!(result["status"], "completed", "{result}");
        assert_eq!(result["result"], "done");
        {
            let requests = provider.requests.lock().unwrap();
            assert_eq!(requests.len(), 101);
            assert!(requests
                .iter()
                .all(|request| request.trace.purpose == ModelCallPurpose::Task));
        }
        let calls = bridge
            .state
            .store
            .list_tool_calls(&bridge.session_id)
            .unwrap();
        assert_eq!(calls.len(), 100);
        assert!(calls.iter().all(|call| {
            call.status == miniq_protocol::ToolCallStatus::Succeeded
                && call.agent_id.as_deref() == Some(id)
        }));
    }
}

#[tokio::test]
async fn restored_child_follow_up_completes_beyond_96_steps() {
    let directory = tempfile::tempdir().unwrap();
    let mut turns = vec![vec![ChatDelta::Text("first result".into())]];
    turns.extend((0..100).map(progress_turn));
    turns.push(vec![ChatDelta::Text("follow-up result".into())]);
    let provider = Arc::new(MockProvider::new(turns));
    let mut bridge = bridge_with_provider(&directory, provider.clone());
    let first = bridge.run(request("inspect")).await.unwrap();
    let id = first["agentId"].as_str().unwrap();
    bridge.state.agent_tasks = Arc::new(AgentTaskManager::new(bridge.state.store.clone()));
    bridge
        .send(AgentMessageRequest {
            recipient: id.into(),
            message: "continue the investigation".into(),
            summary: None,
        })
        .await
        .unwrap();

    let result = bridge
        .output(id, true, Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(result["result"], "follow-up result");
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 102);
    assert!(requests
        .iter()
        .all(|request| request.trace.purpose == ModelCallPurpose::Task));
    assert!(requests[1]
        .messages
        .iter()
        .any(|message| message.content == "first result"));
    assert_eq!(
        requests[1].messages.last().unwrap().content,
        "continue the investigation"
    );
}

#[tokio::test]
async fn child_repeated_tool_guard_still_stops_loops_after_96_steps() {
    let directory = tempfile::tempdir().unwrap();
    let mut turns: Vec<_> = (0..100).map(progress_turn).collect();
    turns.extend((100..105).map(|index| {
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: format!("repeat-{index}"),
            name: "task_update".into(),
            arguments: serde_json::json!({
                "tasks": [{"content": "unchanged", "status": "pending"}]
            }),
        })]
    }));
    let provider = Arc::new(MockProvider::new(turns));
    let bridge = bridge_with_provider(&directory, provider.clone());
    let result = bridge.run(request("detect a stuck child")).await.unwrap();
    assert_eq!(result["status"], "failed", "{result}");
    assert_eq!(
        result["error"],
        "agent repeated the same tool batch 4 times"
    );
    assert_eq!(provider.requests.lock().unwrap().len(), 105);
}
