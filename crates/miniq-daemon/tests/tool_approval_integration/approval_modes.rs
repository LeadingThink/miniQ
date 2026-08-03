use miniq_models::mock::MockProvider;
use miniq_models::ChatDelta;
use serde_json::json;

use crate::support::{call, connect, next_event_of, setup_session, start, tool_call};

/// Default mode ("替我审批"): medium-risk workspace writes run without any
/// approval round-trip — only high risk asks.
#[tokio::test]
async fn medium_writes_auto_approved_in_default_mode() {
    let provider = MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "file_write",
            json!({"path": "a.txt", "content": "1"}),
        )],
        vec![tool_call(
            "c2",
            "file_write",
            json!({"path": "b.txt", "content": "2"}),
        )],
        vec![ChatDelta::Text("both written".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "write both"}}),
    )
    .await;

    // Straight to finished twice — an approval_requested would stall this.
    let first = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(first["status"], "succeeded");
    let second = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(second["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;

    assert!(dir.path().join("a.txt").exists());
    assert!(dir.path().join("b.txt").exists());
}

#[tokio::test]
async fn full_access_mode_skips_approval() {
    let provider = MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "file_write",
            json!({"path": "out.txt", "content": "yes"}),
        )],
        vec![ChatDelta::Text("done".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;

    let response = call(
        &mut ws,
        "m1",
        "settings.update",
        json!({"approvalMode": "fullAccess"}),
    )
    .await;
    assert_eq!(response["result"]["approvalMode"], "fullAccess");

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "write out.txt"}}),
    )
    .await;

    // The write runs straight through — no approval_requested event; waiting
    // for tool_call_finished would time out otherwise.
    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;
    assert_eq!(
        std::fs::read_to_string(dir.path().join("out.txt")).unwrap(),
        "yes"
    );
}

#[tokio::test]
async fn always_ask_mode_ignores_session_grant() {
    let provider = MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "file_write",
            json!({"path": "a.txt", "content": "1"}),
        )],
        vec![tool_call(
            "c2",
            "file_write",
            json!({"path": "b.txt", "content": "2"}),
        )],
        vec![ChatDelta::Text("both written".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "m1",
        "settings.update",
        json!({"approvalMode": "alwaysAsk"}),
    )
    .await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "write both"}}),
    )
    .await;

    // Approve the first write "for session" — always-ask must still ask again.
    let first = next_event_of(&mut ws, "approval_requested").await;
    let first_id = first["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": first_id, "decision": "approve_for_session"}),
    )
    .await;
    let first_finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(first_finished["status"], "succeeded");

    let second = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(second["toolName"], "file_write");
    let second_id = second["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r3",
        "approval.resolve",
        json!({"approvalId": second_id, "decision": "approve"}),
    )
    .await;
    let second_finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(second_finished["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;
}
