//! Sidebar summaries: `session.list` activity fields, the terminal turn
//! summary, and the read-only `settings.schema` catalog.

use super::*;

#[tokio::test]
async fn completed_turn_reports_summary_and_list_shows_activity() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;
    let dir = tempfile::tempdir().unwrap();
    let opened = call(
        &mut ws,
        "open",
        "workspace.open",
        json!({"path": dir.path().to_string_lossy()}),
    )
    .await;
    let workspace_id = opened["result"]["id"].as_str().unwrap().to_string();
    let created = call(
        &mut ws,
        "create",
        "session.create",
        json!({"workspaceId": workspace_id}),
    )
    .await;
    let session_id = created["result"]["id"].as_str().unwrap().to_string();

    let listed = call(
        &mut ws,
        "empty",
        "session.list",
        json!({"workspaceId": workspace_id}),
    )
    .await;
    let empty = &listed["result"]["sessions"][0];
    assert_eq!(empty["turnCount"], 0);
    assert!(empty.get("preview").is_none());
    assert!(empty.get("lastActivityAt").is_none());

    call(
        &mut ws,
        "send",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "hi"}}),
    )
    .await;
    let completed = next_event_of(&mut ws, "turn_completed").await;
    let summary = &completed["summary"];
    assert_eq!(summary["status"], "completed");
    assert_eq!(summary["toolCalls"], 0);
    assert_eq!(summary["failedToolCalls"], 0);
    assert_eq!(summary["filesChanged"], 0);
    assert!(summary["durationMs"].as_u64().is_some());

    let listed = call(
        &mut ws,
        "list",
        "session.list",
        json!({"workspaceId": workspace_id}),
    )
    .await;
    let session = &listed["result"]["sessions"][0];
    assert_eq!(session["id"], session_id.as_str());
    assert_eq!(session["turnCount"], 1);
    assert_eq!(session["preview"], "hello from mock");
    assert!(session["lastActivityAt"].as_str().is_some());
}

#[tokio::test]
async fn settings_schema_returns_ordered_groups_and_defaults() {
    let (port, token) = start_daemon().await;
    let mut ws = connect(port, &token).await;
    let response = call(&mut ws, "schema", "settings.schema", Value::Null).await;
    assert!(response.get("error").is_none(), "{response}");
    let result = &response["result"];
    let groups = result["groups"].as_array().unwrap();
    let ids: Vec<&str> = groups.iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        [
            "general",
            "appearance",
            "services",
            "computer",
            "skills",
            "mcp",
            "plugins",
            "memory"
        ]
    );
    assert_eq!(
        groups[2],
        json!({"id": "services", "label": "服务与远程", "icon": "server"})
    );
    assert_eq!(result["defaults"]["approvalMode"], "auto");
    assert_eq!(result["defaults"]["theme"], "system");
}
