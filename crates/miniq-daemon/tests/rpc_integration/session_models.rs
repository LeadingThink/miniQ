use super::*;

#[tokio::test]
async fn separate_clients_preserve_each_sessions_model_after_creating_another() {
    let (port, token) = start_daemon().await;
    let mut desktop = connect(port, &token).await;
    let mut mobile = connect(port, &token).await;
    let dir = tempfile::tempdir().unwrap();
    let workspace = call(
        &mut desktop,
        "workspace",
        "workspace.open",
        json!({
            "path": dir.path().to_string_lossy()
        }),
    )
    .await["result"]["id"]
        .clone();
    let selected = [
        json!({"model":"claude-sonnet-4.6","apiProtocol":"anthropic_messages","reasoningEffort":null}),
        json!({"model":"gemini-3.8-flash","apiProtocol":"auto","reasoningEffort":null}),
        json!({"model":"gpt-5.6-sol","apiProtocol":"responses","reasoningEffort":null}),
    ];
    let mut sessions = Vec::new();
    for selection in &selected {
        let created = call(
            &mut desktop,
            "create",
            "session.create",
            json!({
                "workspaceId":workspace, "modelSettings":selection
            }),
        )
        .await;
        assert!(created.get("error").is_none(), "{created}");
        sessions.push(created["result"]["id"].clone());
    }
    let project = call(
        &mut desktop,
        "defaults",
        "workspace.modelGet",
        json!({
            "workspaceId":workspace
        }),
    )
    .await;
    assert_eq!(project["result"]["settings"]["model"], Value::Null);
    // Reconnect to force fresh server reads rather than relying on any client cache.
    desktop.close(None).await.unwrap();
    desktop = connect(port, &token).await;
    for (id, selection) in sessions.iter().zip(&selected) {
        for client in [&mut desktop, &mut mobile] {
            let response = call(client, "model", "session.modelGet", json!({"sessionId":id})).await;
            assert_eq!(response["result"]["settings"], *selection);
        }
    }
    let update = call(
        &mut mobile,
        "update",
        "session.modelUpdate",
        json!({
            "sessionId":sessions[2], "settings":{"model":"another-model","apiProtocol":"auto"}
        }),
    )
    .await;
    assert!(update.get("error").is_none(), "{update}");
    for (id, selection) in sessions[..2].iter().zip(&selected) {
        let response = call(
            &mut desktop,
            "model",
            "session.modelGet",
            json!({"sessionId":id}),
        )
        .await;
        assert_eq!(response["result"]["settings"], *selection);
    }
    let response = call(
        &mut desktop,
        "model",
        "session.modelGet",
        json!({"sessionId":sessions[2]}),
    )
    .await;
    assert_eq!(response["result"]["settings"]["model"], "another-model");
}
