use super::*;
use std::time::Duration;

fn named(name: &str) -> AgentRunRequest {
    AgentRunRequest {
        name: Some(name.into()),
        run_in_background: true,
        ..request(name)
    }
}

#[tokio::test]
async fn settle_children_waits_only_for_active_direct_children() {
    let directory = tempfile::tempdir().unwrap();
    let bridge = bridge_with_provider(&directory, Arc::new(MockProvider::text("unused")));
    let manager = bridge.state.agent_tasks.clone();
    let session = bridge.session_id.clone();
    let cancel = CancellationToken::new();

    assert!(manager
        .settle_children(&session, None, Duration::from_secs(5), &cancel)
        .await
        .is_empty());

    let (top_id, top) = manager
        .create(&session, None, &named("top"), CancellationToken::new())
        .await
        .unwrap();
    let (_nested_id, _nested) = manager
        .create(
            &session,
            Some(&top_id),
            &named("nested"),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let finisher = {
        let manager = manager.clone();
        let top = top.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            manager
                .finish_turn(&top, "top result".into(), vec![ChatMessage::user("top")])
                .await
                .unwrap();
            manager.complete(&top).await.unwrap();
        })
    };
    let settled = manager
        .settle_children(&session, None, Duration::from_secs(5), &cancel)
        .await;
    finisher.await.unwrap();
    assert_eq!(settled.len(), 1, "{settled:?}");
    assert_eq!(settled[0]["agentId"], top_id.as_str());
    assert_eq!(settled[0]["status"], "completed");

    // The nested child belongs to `top`, so only its parent waits for it; the
    // timeout bounds one wait round and reports it as still running.
    let pending = manager
        .settle_children(&session, Some(&top_id), Duration::from_millis(20), &cancel)
        .await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["status"], "running");

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let started = std::time::Instant::now();
    manager
        .settle_children(&session, Some(&top_id), Duration::from_secs(30), &cancelled)
        .await;
    assert!(started.elapsed() < Duration::from_secs(5));
}
