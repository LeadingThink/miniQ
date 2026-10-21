use super::*;
use crate::client::test_fixture::{Fixture, Reply};
use serde_json::json;

const BUSY: i64 = miniq_protocol::ErrorCode::SessionBusy as i64;

#[tokio::test]
async fn idle_activation_uses_only_atomic_non_cancelling_shutdown() {
    let mut fixture = Fixture::new(vec![(
        "daemon.shutdownIfIdle",
        Reply::Result(json!({"accepted":true,"cancelledTurns":0,"cancelledAgents":0})),
    )])
    .await;
    assert!(request_shutdown(&mut fixture.client, false, false)
        .await
        .unwrap());
    assert_eq!(fixture.finish().await.len(), 1);
}

#[tokio::test]
async fn busy_activation_defers_without_stop_authorization() {
    let mut fixture = Fixture::new(vec![(
        "daemon.shutdownIfIdle",
        Reply::Error(BUSY, "tasks running"),
    )])
    .await;
    assert!(!request_shutdown(&mut fixture.client, false, false)
        .await
        .unwrap());
    assert_eq!(fixture.finish().await.len(), 1);
}

#[tokio::test]
async fn explicit_stop_requires_a_confirmed_busy_guard_rejection() {
    let mut fixture = Fixture::new(vec![
        ("daemon.shutdownIfIdle", Reply::Error(BUSY, "tasks running")),
        (
            "daemon.shutdown",
            Reply::Result(json!({"accepted":true,"cancelledTurns":1,"cancelledAgents":2})),
        ),
    ])
    .await;
    assert!(request_shutdown(&mut fixture.client, true, false)
        .await
        .unwrap());
    assert_eq!(fixture.finish().await.len(), 2);
}

#[tokio::test]
async fn unknown_shutdown_failures_never_trigger_fallback_or_replay() {
    for reply in [Reply::Error(-32603, "tasks running"), Reply::Disconnect] {
        let mut fixture = Fixture::new(vec![("daemon.shutdownIfIdle", reply)]).await;
        assert!(request_shutdown(&mut fixture.client, true, false)
            .await
            .is_err());
        assert_eq!(fixture.finish().await.len(), 1);
    }
    let mut fixture = Fixture::new(vec![
        ("daemon.shutdownIfIdle", Reply::Error(BUSY, "busy")),
        ("daemon.shutdown", Reply::Disconnect),
    ])
    .await;
    assert!(request_shutdown(&mut fixture.client, true, false)
        .await
        .is_err());
    assert_eq!(fixture.finish().await.len(), 2);
}
