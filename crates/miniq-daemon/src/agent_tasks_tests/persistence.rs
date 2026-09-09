use super::*;
use miniq_agent::{CheckpointStore, TurnCheckpoint};
use serde_json::json;

fn reopen(bridge: &DaemonAgentBridge) -> DaemonAgentBridge {
    bridge.state.store.recover_interrupted_work().unwrap();
    let mut restored = bridge.clone();
    restored.state.agent_tasks = Arc::new(AgentTaskManager::new(bridge.state.store.clone()));
    restored
}

#[tokio::test]
async fn disk_database_reopens_without_loading_large_history_or_result_into_the_list() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agents.sqlite");
    let store = Arc::new(miniq_memory::Store::open(&path).unwrap());
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "test")
        .unwrap();
    let session = store.create_session(&workspace.id, "test").unwrap();
    let manager = AgentTaskManager::new(store.clone());
    let (id, record) = manager
        .create(
            &session.id,
            None,
            &request("inspect"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let large = "complete result ".repeat(100_000);
    manager
        .finish_turn(
            &record,
            large.clone(),
            vec![ChatMessage::assistant(large.clone())],
        )
        .await
        .unwrap();
    manager.complete(&record).await.unwrap();
    drop(record);
    drop(manager);
    drop(store);
    let store = Arc::new(miniq_memory::Store::open(&path).unwrap());
    store.recover_interrupted_work().unwrap();
    let restored = AgentTaskManager::new(store);
    let list = restored.list(&session.id).await.unwrap();
    assert!(serde_json::to_vec(&list).unwrap().len() < 2000);
    assert_eq!(
        restored
            .output(&session.id, &id, false, Duration::ZERO)
            .await
            .unwrap()["result"],
        large
    );
    let (_, _, history) = restored
        .prepare_resume(
            &session.id,
            &id,
            &mut request("continue"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(history[0].content, large);
}

#[tokio::test]
async fn completed_agents_keep_identity_results_and_history_after_manager_restart() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::new(vec![
        vec![ChatDelta::Text("verified first result".into())],
        vec![ChatDelta::Text("resumed result".into())],
    ]));
    let bridge = bridge_with_provider(&directory, provider.clone());
    let initial = bridge.run(request("inspect only once")).await.unwrap();
    let restored = reopen(&bridge);
    let listed = restored
        .state
        .agent_tasks
        .list(&bridge.session_id)
        .await
        .unwrap();
    assert_eq!(listed[0]["agentId"], initial["agentId"]);
    assert_eq!(listed[0]["status"], "completed");
    assert_eq!(listed[0]["elapsedMs"], initial["elapsedMs"]);
    assert!(listed[0].get("result").is_none());
    assert!(listed[0].get("history").is_none());
    let output = restored
        .output("researcher", false, Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(output["result"], "verified first result");
    assert_eq!(
        provider.requests.lock().unwrap().len(),
        1,
        "restart must not run a model"
    );
    let mut resume = request("follow up without replay");
    resume.name = None;
    resume.resume = Some("researcher".into());
    let next = restored.run(resume).await.unwrap();
    assert_eq!(next["agentId"], initial["agentId"]);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1]
        .messages
        .iter()
        .any(|message| message.content == "verified first result"));
    assert_eq!(
        requests[1].messages.last().unwrap().content,
        "follow up without replay"
    );
}

#[tokio::test]
async fn interrupted_agent_retains_checkpoint_and_holds_unsent_messages_without_replaying() {
    let directory = tempfile::tempdir().unwrap();
    let bridge = bridge_with_provider(&directory, Arc::new(MockProvider::text("unused")));
    let manager = &bridge.state.agent_tasks;
    let (id, record) = manager
        .create(
            &bridge.session_id,
            None,
            &request("inspect"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    manager
        .save_history(
            &record,
            &[
                ChatMessage::system("agent"),
                ChatMessage::assistant("already verified"),
            ],
        )
        .await
        .unwrap();
    manager
        .route_message(&bridge.session_id, &id, "unsent instruction".into())
        .await
        .unwrap();
    let stored_elapsed = bridge
        .state
        .store
        .list_agent_tasks(&bridge.session_id)
        .unwrap()[0]
        .state["elapsedMs"]
        .clone();
    let restored = reopen(&bridge);
    let output = restored.output(&id, false, Duration::ZERO).await.unwrap();
    assert_eq!(output["status"], "interrupted");
    assert_eq!(output["elapsedMs"], stored_elapsed);
    assert_eq!(output["timingComplete"], false);
    assert_eq!(output["queuedMessages"], 0);
    assert_eq!(output["heldMessages"], json!(["unsent instruction"]));
    let mut resume = request("new question");
    let (_, _, history) = restored
        .state
        .agent_tasks
        .prepare_resume(
            &bridge.session_id,
            &id,
            &mut resume,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(history
        .iter()
        .any(|message| message.content == "already verified"));
    assert!(history
        .iter()
        .any(|message| message.content.contains("not an automatic replay")));
    assert!(!history
        .iter()
        .any(|message| message.content == "unsent instruction"));
    let again = reopen(&restored);
    assert_eq!(
        again.output(&id, false, Duration::ZERO).await.unwrap()["heldMessages"],
        json!(["unsent instruction"])
    );
}

#[tokio::test]
async fn restored_names_and_history_remain_session_scoped() {
    let directory = tempfile::tempdir().unwrap();
    let bridge = bridge_with_provider(&directory, Arc::new(MockProvider::text("first")));
    let first = bridge.run(request("inspect")).await.unwrap();
    let mut restored = reopen(&bridge);
    restored.session_id = bridge
        .state
        .store
        .create_session(&bridge.workspace_id, "other")
        .unwrap()
        .id;
    let id = first["agentId"].as_str().unwrap();
    assert!(restored.output(id, false, Duration::ZERO).await.is_err());
    assert!(restored
        .state
        .agent_tasks
        .list(&restored.session_id)
        .await
        .unwrap()
        .is_empty());
    assert!(restored
        .state
        .store
        .agent_history(&restored.session_id, id)
        .is_err());
    assert!(restored
        .state
        .store
        .agent_result(&restored.session_id, id)
        .is_err());
    assert!(restored
        .state
        .agent_tasks
        .create(
            &restored.session_id,
            None,
            &request("own researcher"),
            CancellationToken::new()
        )
        .await
        .is_ok());
}

#[tokio::test]
async fn checkpoint_failure_is_reported_and_failed_enqueue_does_not_change_live_queue() {
    let directory = tempfile::tempdir().unwrap();
    let bridge = bridge_with_provider(&directory, Arc::new(MockProvider::text("unused")));
    let manager = &bridge.state.agent_tasks;
    let (id, record) = manager
        .create(
            &bridge.session_id,
            None,
            &request("inspect"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    bridge
        .state
        .store
        .delete_agent_task(&bridge.session_id, &id)
        .unwrap();
    let checkpoint = crate::turn_checkpoint::AgentCheckpoint {
        manager: manager.clone(),
        record: record.clone(),
    };
    let error = checkpoint
        .save(TurnCheckpoint {
            history: vec![ChatMessage::user("next")],
            display_text: String::new(),
            stopped: false,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, miniq_agent::AgentError::Checkpoint(_)));
    assert!(manager
        .route_message(&bridge.session_id, &id, "do not enqueue".into())
        .await
        .is_err());
    assert_eq!(manager.snapshot(&id, &record).await["queuedMessages"], 0);
}

#[tokio::test]
async fn checkpoint_and_dequeued_prompt_survive_restart_together() {
    let directory = tempfile::tempdir().unwrap();
    let bridge = bridge_with_provider(&directory, Arc::new(MockProvider::text("unused")));
    let manager = &bridge.state.agent_tasks;
    let (id, record) = manager
        .create(
            &bridge.session_id,
            None,
            &request("first"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    manager
        .route_message(&bridge.session_id, &id, "next turn".into())
        .await
        .unwrap();
    let next = manager
        .finish_turn(
            &record,
            "first result".into(),
            vec![ChatMessage::assistant("first result")],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.last().unwrap().content, "next turn");
    let persisted: Vec<ChatMessage> = serde_json::from_value(
        bridge
            .state
            .store
            .agent_history(&bridge.session_id, &id)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(persisted.last().unwrap().content, "next turn");
    assert_eq!(
        reopen(&bridge)
            .output(&id, false, Duration::ZERO)
            .await
            .unwrap()["queuedMessages"],
        0
    );
}
