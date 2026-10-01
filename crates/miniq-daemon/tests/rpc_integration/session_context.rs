use super::*;

async fn open_session(ws: &mut WsClient, dir: &tempfile::TempDir) -> String {
    let workspace = call(
        ws,
        "workspace",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await["result"]["id"]
        .clone();
    call(
        ws,
        "create",
        "session.create",
        json!({"workspaceId": workspace}),
    )
    .await["result"]["id"]
        .as_str()
        .expect("session id")
        .to_string()
}

#[tokio::test]
async fn context_usage_compact_and_undo_round_trip() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;
    let dir = tempfile::tempdir().unwrap();
    let session = open_session(&mut ws, &dir).await;

    let empty = call(&mut ws, "u0", "session.undo", json!({"sessionId": session})).await;
    assert!(
        empty["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("nothing to undo"),
        "{empty}"
    );
    let compact = call(
        &mut ws,
        "c0",
        "session.compact",
        json!({"sessionId": session}),
    )
    .await;
    assert_eq!(compact["result"]["compacted"], false, "{compact}");

    let sent = call(
        &mut ws,
        "send",
        "session.sendMessage",
        json!({"sessionId": session, "message": {"role": "user", "content": "hi"}}),
    )
    .await;
    assert!(sent.get("error").is_none(), "{sent}");
    next_event_of(&mut ws, "turn_completed").await;

    let usage = call(
        &mut ws,
        "ctx",
        "session.contextUsage",
        json!({"sessionId": session}),
    )
    .await;
    assert!(usage.get("error").is_none(), "{usage}");
    assert!(
        usage["result"]["estimatedTokens"].as_u64().unwrap() > 0,
        "{usage}"
    );
    assert!(usage["result"].get("contextWindowTokens").is_some());
    assert!(usage["result"].get("percentUsed").is_some());

    let compact = call(
        &mut ws,
        "c1",
        "session.compact",
        json!({"sessionId": session}),
    )
    .await;
    assert!(compact.get("error").is_none(), "{compact}");
    assert!(compact["result"]["compacted"].is_boolean(), "{compact}");

    let undo = call(&mut ws, "u1", "session.undo", json!({"sessionId": session})).await;
    assert!(undo.get("error").is_none(), "{undo}");
    assert_eq!(undo["result"]["removedMessage"]["content"], "hi");
    assert_eq!(
        undo["result"]["removedMessageIds"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "{undo}"
    );
    assert_eq!(undo["result"]["failedFiles"], json!([]));

    let reopened = call(
        &mut ws,
        "open",
        "session.open",
        json!({"sessionId": session}),
    )
    .await;
    assert_eq!(reopened["result"]["messages"], json!([]));
}

#[tokio::test]
async fn send_message_rejects_out_of_range_max_turns() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;
    let dir = tempfile::tempdir().unwrap();
    let session = open_session(&mut ws, &dir).await;
    for (id, value) in [("zero", 0), ("big", 1001)] {
        let resp = call(
            &mut ws,
            id,
            "session.sendMessage",
            json!({
                "sessionId": session,
                "maxTurns": value,
                "message": {"role": "user", "content": "hi"}
            }),
        )
        .await;
        assert!(
            resp["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("maxTurns must be between 1 and 1000"),
            "{resp}"
        );
    }
}
