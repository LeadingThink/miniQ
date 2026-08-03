use miniq_models::mock::MockProvider;
use miniq_models::ChatDelta;
use serde_json::json;

use crate::support::{call, connect, next_event_of, setup_session, start, tool_call};

#[tokio::test]
async fn write_tool_requires_approval_and_runs_after_approve() {
    let provider = MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "file_write",
            json!({"path": "out.txt", "content": "written!"}),
        )],
        vec![ChatDelta::Text("done".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;
    // Medium risk auto-runs in the default mode; alwaysAsk exercises the
    // approval flow.
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
        json!({"sessionId": session_id, "message": {"role": "user", "content": "write out.txt"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "file_write");
    assert_eq!(requested["riskLevel"], "medium");
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();

    // File must NOT exist while waiting.
    assert!(!dir.path().join("out.txt").exists());

    let response = call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve"}),
    )
    .await;
    assert_eq!(response["result"]["resolved"], true);

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "succeeded");
    next_event_of(&mut ws, "turn_completed").await;

    assert_eq!(
        std::fs::read_to_string(dir.path().join("out.txt")).unwrap(),
        "written!"
    );
}

#[tokio::test]
async fn rejected_approval_returns_structured_rejection() {
    let provider = MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "file_write",
            json!({"path": "out.txt", "content": "nope"}),
        )],
        vec![ChatDelta::Text("understood, not writing".into())],
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
        json!({"sessionId": session_id, "message": {"role": "user", "content": "write out.txt"}}),
    )
    .await;

    let requested = next_event_of(&mut ws, "approval_requested").await;
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();

    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "reject"}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "rejected");
    assert_eq!(finished["output"]["rejected"], true);
    next_event_of(&mut ws, "turn_completed").await;

    assert!(!dir.path().join("out.txt").exists());
}

#[tokio::test]
async fn blocked_command_is_rejected_without_approval() {
    let provider = MockProvider::new(vec![
        vec![tool_call("c1", "shell_run", json!({"command": "rm -rf /"}))],
        vec![ChatDelta::Text("that command is blocked".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "clean up"}}),
    )
    .await;

    let finished = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(finished["status"], "rejected");
    assert_eq!(finished["output"]["riskLevel"], "blocked");
    next_event_of(&mut ws, "turn_completed").await;
}
