//! Empty projects and sessions must become visible in another connected client.

use super::*;

#[tokio::test]
async fn newly_opened_or_created_projects_and_empty_sessions_broadcast_matching_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::with_settings(
        Store::open_in_memory().unwrap(),
        "catalog-test".into(),
        Default::default(),
        directory.path().join("settings.json"),
    );
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serving = state.clone();
    let server = tokio::spawn(async move {
        server::serve(listener, serving).await.unwrap();
    });
    let mut creator = connect(port, "catalog-test").await;
    let mut observer = connect(port, "catalog-test").await;
    // Establish the observer's event subscription before the creator modifies the catalog.
    call(&mut observer, "ready", "daemon.health", Value::Null).await;
    let project = tempfile::tempdir().unwrap();
    let opened = call(
        &mut creator,
        "open",
        "workspace.open",
        json!({"path":project.path()}),
    )
    .await;
    assert!(opened.get("error").is_none());
    let updated = next_event_of(&mut observer, "workspace_updated").await;
    assert_eq!(updated["workspace"], opened["result"]);
    assert!(updated["eventCursor"]["sequence"].as_u64().is_some());

    let created = call(
        &mut creator,
        "create",
        "workspace.create",
        json!({"name":"empty-project"}),
    )
    .await;
    assert!(created.get("error").is_none());
    let updated = next_event_of(&mut observer, "workspace_updated").await;
    assert_eq!(updated["workspace"], created["result"]);
    let expected = directory
        .path()
        .join("projects/empty-project")
        .canonicalize()
        .unwrap();
    assert_eq!(
        std::path::Path::new(created["result"]["path"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        expected
    );
    let projects = call(&mut observer, "projects", "workspace.list", Value::Null).await;
    assert!(projects["result"]["workspaces"]
        .as_array()
        .unwrap()
        .contains(&created["result"]));

    let session = call(
        &mut creator,
        "session",
        "session.create",
        json!({"workspaceId":created["result"]["id"]}),
    )
    .await;
    assert!(session.get("error").is_none());
    let changed = next_event_of(&mut observer, "session_status_changed").await;
    assert_eq!(changed["sessionId"], session["result"]["id"]);
    assert_eq!(changed["status"], session["result"]["status"]);
    assert_eq!(changed["status"], "idle");
    let sessions = call(
        &mut observer,
        "sessions",
        "session.list",
        json!({"workspaceId":created["result"]["id"]}),
    )
    .await;
    assert_eq!(
        sessions["result"]["sessions"],
        json!([session["result"].clone()])
    );
    let opened = call(
        &mut observer,
        "empty",
        "session.open",
        json!({"sessionId":session["result"]["id"]}),
    )
    .await;
    assert_eq!(opened["result"]["messages"], json!([]));
    state.shutdown.cancel();
    drop(creator);
    drop(observer);
    tokio::time::timeout(std::time::Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
