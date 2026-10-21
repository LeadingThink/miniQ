use super::*;
use crate::client::test_fixture::{Fixture, Reply};

const BUSY: i64 = miniq_protocol::ErrorCode::SessionBusy as i64;

#[tokio::test]
async fn default_reject_preserves_the_active_task() {
    let mut fixture = Fixture::new(vec![("session.sendMessage", Reply::Error(BUSY, "busy"))]).await;
    assert!(send_with_policy(
        &mut fixture.client,
        "session",
        "hello",
        &[],
        Some(BusyPolicy::Reject)
    )
    .await
    .is_err());
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["params"]["rejectIfBusy"], true);
}

#[tokio::test]
async fn explicit_queue_returns_queued_identity_without_claiming_completion() {
    let mut fixture = Fixture::new(vec![(
        "session.sendMessage",
        Reply::Result(json!({"queued":{"id":"queued-1"}})),
    )])
    .await;
    fixture.client.max_turns = Some(12);
    let outcome = send_with_policy(
        &mut fixture.client,
        "session",
        "hello",
        &[],
        Some(BusyPolicy::Queue),
    )
    .await
    .unwrap();
    assert_eq!(
        outcome,
        SendOutcome::Queued {
            id: "queued-1".into()
        }
    );
    let requests = fixture.finish().await;
    assert_eq!(requests[0]["params"]["rejectIfBusy"], false);
    assert_eq!(requests[0]["params"]["maxTurns"], 12);
}

#[tokio::test]
async fn explicit_stop_waits_until_idle_then_submits_with_atomic_reject() {
    let mut fixture = Fixture::new(vec![
        ("session.sendMessage", Reply::Error(BUSY, "busy")),
        ("session.cancel", Reply::Result(json!({"cancelled":true}))),
        (
            "session.open",
            Reply::Result(json!({"session":{"status":"cancelling"}})),
        ),
        (
            "session.open",
            Reply::Result(json!({"session":{"status":"idle"}})),
        ),
        (
            "session.sendMessage",
            Reply::Result(json!({"message":{"id":"message"}})),
        ),
    ])
    .await;
    assert_eq!(
        send_with_policy(
            &mut fixture.client,
            "session",
            "hello",
            &[],
            Some(BusyPolicy::Stop)
        )
        .await
        .unwrap(),
        SendOutcome::Started
    );
    let requests = fixture.finish().await;
    assert_eq!(requests[0]["params"], requests[4]["params"]);
    assert_eq!(requests[4]["params"]["rejectIfBusy"], true);
}

#[tokio::test]
async fn stop_does_not_cancel_an_unrelated_task_that_wins_new_admission() {
    let mut fixture = Fixture::new(vec![
        ("session.sendMessage", Reply::Error(BUSY, "first task")),
        ("session.cancel", Reply::Result(json!({"cancelled":true}))),
        (
            "session.open",
            Reply::Result(json!({"session":{"status":"idle"}})),
        ),
        ("session.sendMessage", Reply::Error(BUSY, "new contender")),
    ])
    .await;
    assert!(send_with_policy(
        &mut fixture.client,
        "session",
        "hello",
        &[],
        Some(BusyPolicy::Stop)
    )
    .await
    .is_err());
    assert_eq!(fixture.finish().await.len(), 4);
}

#[tokio::test]
async fn ambiguous_send_and_cancel_failures_are_never_replayed() {
    for policy in [BusyPolicy::Reject, BusyPolicy::Queue, BusyPolicy::Stop] {
        let mut fixture = Fixture::new(vec![("session.sendMessage", Reply::Disconnect)]).await;
        assert!(
            send_with_policy(&mut fixture.client, "session", "hello", &[], Some(policy))
                .await
                .is_err()
        );
        assert_eq!(fixture.finish().await.len(), 1);
    }
    let mut fixture = Fixture::new(vec![
        ("session.sendMessage", Reply::Error(BUSY, "busy")),
        ("session.cancel", Reply::Disconnect),
    ])
    .await;
    assert!(send_with_policy(
        &mut fixture.client,
        "session",
        "hello",
        &[],
        Some(BusyPolicy::Stop)
    )
    .await
    .is_err());
    assert_eq!(fixture.finish().await.len(), 2);
}

#[tokio::test]
async fn busy_wording_without_busy_code_never_authorizes_mutation() {
    let mut fixture = Fixture::new(vec![(
        "session.sendMessage",
        Reply::Error(-32603, "session busy"),
    )])
    .await;
    let error = send_with_policy(
        &mut fixture.client,
        "session",
        "hello",
        &[],
        Some(BusyPolicy::Stop),
    )
    .await
    .unwrap_err();
    let rpc = error.downcast_ref::<crate::client::RpcCallError>().unwrap();
    assert_eq!(rpc.method, "session.sendMessage");
    assert_eq!(rpc.code, -32603);
    assert_eq!(rpc.data, Some(json!({"fixture":true})));
    assert_eq!(fixture.finish().await.len(), 1);
}

#[tokio::test]
async fn guarded_send_never_treats_a_silent_queue_as_started() {
    let mut fixture = Fixture::new(vec![(
        "session.sendMessage",
        Reply::Result(json!({"queued":{"id":"queued-1"}})),
    )])
    .await;
    assert!(send_with_policy(
        &mut fixture.client,
        "session",
        "hello",
        &[],
        Some(BusyPolicy::Reject)
    )
    .await
    .is_err());
    assert_eq!(fixture.finish().await.len(), 1);
}
