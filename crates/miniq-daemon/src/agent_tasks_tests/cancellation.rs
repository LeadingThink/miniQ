use super::*;
use miniq_protocol::RpcRequest;
use serde_json::json;

async fn background(bridge: &DaemonAgentBridge, name: &str) -> String {
    let mut request = request("wait without touching files");
    request.name = Some(name.into());
    request.run_in_background = true;
    bridge.run(request).await.unwrap()["agentId"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn wait_requests(provider: &GatedProvider, count: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while provider.requests.lock().await.len() < count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn assert_cancelled(bridge: &DaemonAgentBridge, id: &str) {
    assert_eq!(
        bridge
            .output(id, true, Duration::from_secs(2))
            .await
            .unwrap()["status"],
        "cancelled"
    );
}

#[tokio::test]
async fn parent_turn_cancellation_reaches_background_children() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let mut bridge = bridge_with_provider(&directory, provider.clone());
    bridge.cancel = bridge.state.begin_turn(&bridge.session_id).unwrap();
    let id = background(&bridge, "child").await;
    wait_requests(&provider, 1).await;
    assert!(bridge.state.cancel_turn(&bridge.session_id));
    assert_cancelled(&bridge, &id).await;
    assert!(bridge.run(request("late spawn")).await.is_err());
    assert_eq!(provider.requests.lock().await.len(), 1);
    bridge.state.end_turn(&bridge.session_id);
}

#[tokio::test]
async fn dropping_cancelled_foreground_call_does_not_abandon_agent_cleanup() {
    for isolation in [None, Some("worktree")] {
        let directory = tempfile::tempdir().unwrap();
        if isolation.is_some() {
            for arguments in [
                vec!["init", "-q"],
                vec![
                    "-c",
                    "user.name=miniQ Test",
                    "-c",
                    "user.email=miniq@test.invalid",
                    "-c",
                    "commit.gpgSign=false",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "initial",
                ],
            ] {
                let output = std::process::Command::new("git")
                    .arg("-C")
                    .arg(directory.path())
                    .args(arguments)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        let provider = Arc::new(GatedProvider::new());
        let bridge = bridge_with_provider(&directory, provider.clone());
        let mut input = request("foreground");
        input.isolation = isolation.map(str::to_owned);
        let mut call = Box::pin(bridge.run(input));
        tokio::select! {
            result = &mut call => panic!("agent returned before cancellation: {result:?}"),
            _ = wait_requests(&provider, 1) => {}
        }
        let agents = bridge.state.agent_tasks.list(&bridge.session_id).await;
        let id = agents[0]["agentId"].as_str().unwrap();
        let worktree = agents[0]["worktreePath"].as_str().map(PathBuf::from);
        assert_eq!(worktree.is_some(), isolation.is_some());
        bridge.cancel.cancel();
        drop(call);
        assert_cancelled(&bridge, id).await;
        if let Some(worktree) = worktree {
            assert!(!worktree.exists(), "clean worktree was abandoned");
            assert!(
                bridge.output(id, false, Duration::ZERO).await.unwrap()["worktreeError"].is_null()
            );
        }
    }
}

#[tokio::test]
async fn session_cancel_covers_background_work_after_parent_ends_but_not_other_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let mut first = bridge_with_provider(&directory, provider.clone());
    first.cancel = first.state.begin_turn(&first.session_id).unwrap();
    let one = background(&first, "child").await;
    let mut second = first.clone();
    second.session_id = second
        .state
        .store
        .create_session(&second.workspace_id, "other")
        .unwrap()
        .id;
    second.cancel = CancellationToken::new();
    let two = background(&second, "child").await;
    wait_requests(&provider, 2).await;
    first.state.end_turn(&first.session_id);
    assert!(!first.cancel.is_cancelled());
    let response = crate::gateway::dispatch(
        &first.state,
        RpcRequest::new(
            "stop",
            "session.cancel",
            Some(json!({"sessionId":first.session_id})),
        ),
    )
    .await;
    assert!(response.error.is_none(), "{:?}", response.error);
    assert_eq!(response.result.unwrap()["cancelled"], true);
    assert_cancelled(&first, &one).await;
    assert_eq!(
        second.output(&two, false, Duration::ZERO).await.unwrap()["status"],
        "running"
    );
    assert_eq!(second.stop(&two).await.unwrap()["status"], "cancelled");
}

#[tokio::test]
async fn stopping_completed_parent_stops_descendants_without_stopping_siblings() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    let token = bridge.cancel.child_token();
    let (parent_id, parent) = bridge
        .state
        .agent_tasks
        .create(&bridge.session_id, None, &request("parent"), token.clone())
        .await
        .unwrap();
    bridge
        .state
        .agent_tasks
        .finish_turn(&parent, "done".into(), vec![])
        .await;
    bridge.state.agent_tasks.complete(&parent).await;
    let child_bridge = DaemonAgentBridge {
        agent_id: Some(parent_id.clone()),
        cancel: token.clone(),
        depth: 1,
        ..bridge.clone()
    };
    let child = background(&child_bridge, "child").await;
    // A resumed descendant may have a new turn token: ancestry still controls stop.
    let grandchild_bridge = DaemonAgentBridge {
        agent_id: Some(child.clone()),
        cancel: CancellationToken::new(),
        depth: 2,
        ..bridge.clone()
    };
    let grandchild = background(&grandchild_bridge, "grandchild").await;
    let sibling = background(&bridge, "sibling").await;
    wait_requests(&provider, 3).await;
    assert_eq!(
        bridge.stop(&parent_id).await.unwrap()["status"],
        "completed"
    );
    assert!(token.is_cancelled());
    assert_cancelled(&bridge, &child).await;
    assert_cancelled(&bridge, &grandchild).await;
    assert_eq!(
        bridge
            .output(&sibling, false, Duration::ZERO)
            .await
            .unwrap()["status"],
        "running"
    );
    assert_eq!(bridge.stop(&sibling).await.unwrap()["status"], "cancelled");
}

#[tokio::test]
async fn explicit_stop_discards_queued_messages_before_resume() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    let id = background(&bridge, "child").await;
    wait_requests(&provider, 1).await;
    bridge
        .send(AgentMessageRequest {
            recipient: id.clone(),
            message: "obsolete queued work".into(),
            summary: None,
        })
        .await
        .unwrap();
    let stopped = bridge.stop(&id).await.unwrap();
    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(stopped["queuedMessages"], 0);
    bridge
        .send(AgentMessageRequest {
            recipient: id.clone(),
            message: "new follow-up".into(),
            summary: None,
        })
        .await
        .unwrap();
    provider.gate.add_permits(1);
    assert_eq!(
        bridge
            .output(&id, true, Duration::from_secs(2))
            .await
            .unwrap()["status"],
        "completed"
    );
    let requests = provider.requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert!(!requests[1]
        .messages
        .iter()
        .any(|message| message.content == "obsolete queued work"));
}

#[tokio::test]
async fn shutdown_signals_detached_agents_too() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(GatedProvider::new());
    let bridge = bridge_with_provider(&directory, provider.clone());
    let id = background(&bridge, "child").await;
    wait_requests(&provider, 1).await;
    let response = crate::gateway::dispatch(
        &bridge.state,
        RpcRequest::new("stop", "daemon.shutdown", None),
    )
    .await;
    assert_eq!(response.result.unwrap()["cancelledAgents"], 1);
    assert_cancelled(&bridge, &id).await;
    tokio::time::timeout(Duration::from_secs(2), bridge.state.shutdown.cancelled())
        .await
        .unwrap();
}

#[tokio::test]
async fn cancellation_during_finalization_cannot_report_completed() {
    let directory = tempfile::tempdir().unwrap();
    let bridge = bridge_with_provider(&directory, Arc::new(GatedProvider::new()));
    let token = CancellationToken::new();
    let (id, record) = bridge
        .state
        .agent_tasks
        .create(&bridge.session_id, None, &request("test"), token.clone())
        .await
        .unwrap();
    bridge
        .state
        .agent_tasks
        .finish_turn(&record, "result".into(), vec![])
        .await;
    assert_eq!(
        bridge
            .state
            .agent_tasks
            .cancel_session(&bridge.session_id)
            .await,
        1
    );
    bridge.state.agent_tasks.complete(&record).await;
    assert!(token.is_cancelled());
    assert_cancelled(&bridge, &id).await;
}
