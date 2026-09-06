use super::*;

async fn create(context: &ToolContext, subject: &str) -> String {
    TaskCreateTool
        .execute(context, json!({"subject":subject,"description":subject}))
        .await
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn update(context: &ToolContext, input: Value) -> Value {
    TaskItemUpdateTool.execute(context, input).await.unwrap()
}

async fn rejects_unchanged(context: &ToolContext, input: Value, message: &str) {
    let before = TaskListTool.execute(context, json!({})).await.unwrap();
    let error = TaskItemUpdateTool
        .execute(context, input)
        .await
        .unwrap_err();
    assert!(error.to_string().contains(message), "{error}");
    assert_eq!(
        TaskListTool.execute(context, json!({})).await.unwrap(),
        before
    );
}

#[tokio::test]
async fn dependency_cycles_are_rejected_atomically() {
    let context = ToolContext::new(std::path::PathBuf::from("."));
    let a = create(&context, "A").await;
    let b = create(&context, "B").await;
    let c = create(&context, "C").await;
    update(&context, json!({"taskId":b,"addBlockedBy":[a]})).await;
    update(&context, json!({"taskId":c,"addBlockedBy":[b]})).await;
    for dependency in [&b, &c] {
        rejects_unchanged(
            &context,
            json!({"taskId":a,"addBlockedBy":[dependency],"subject":"must not leak"}),
            "cycle",
        )
        .await;
    }
}

#[tokio::test]
async fn simultaneous_links_are_validated_as_one_graph() {
    let context = ToolContext::new(std::path::PathBuf::from("."));
    let a = create(&context, "A").await;
    let b = create(&context, "B").await;
    rejects_unchanged(
        &context,
        json!({"taskId":a,"addBlocks":[b],"addBlockedBy":[b]}),
        "cycle",
    )
    .await;
}

#[tokio::test]
async fn unfinished_dependencies_prevent_start_and_completion() {
    let context = ToolContext::new(std::path::PathBuf::from("."));
    let a = create(&context, "A").await;
    let b = create(&context, "B").await;
    for status in ["in_progress", "completed"] {
        rejects_unchanged(
            &context,
            json!({"taskId":b,"addBlockedBy":[a],"status":status,"owner":"reviewer"}),
            "blockers are unfinished",
        )
        .await;
    }
    update(&context, json!({"taskId":b,"addBlockedBy":[a]})).await;
    update(&context, json!({"taskId":a,"status":"completed"})).await;
    let started = update(&context, json!({"taskId":b,"status":"in_progress"})).await;
    assert_eq!(started["task"]["status"], "in_progress");
    let finished = update(&context, json!({"taskId":b,"status":"completed"})).await;
    assert_eq!(finished["task"]["status"], "completed");
}

#[tokio::test]
async fn reverse_links_and_reopened_blockers_cannot_invalidate_active_tasks() {
    let context = ToolContext::new(std::path::PathBuf::from("."));
    let a = create(&context, "A").await;
    let b = create(&context, "B").await;
    update(&context, json!({"taskId":b,"status":"in_progress"})).await;
    rejects_unchanged(&context, json!({"taskId":a,"addBlocks":[b]}), "unfinished").await;
    update(
        &context,
        json!({"taskId":a,"status":"completed","addBlocks":[b]}),
    )
    .await;
    rejects_unchanged(
        &context,
        json!({"taskId":a,"status":"pending"}),
        "unfinished",
    )
    .await;
    update(&context, json!({"taskId":b,"status":"pending"})).await;
    update(&context, json!({"taskId":a,"status":"pending"})).await;
}

#[tokio::test]
async fn creates_links_updates_and_deletes_tasks() {
    let context = ToolContext::new(std::path::PathBuf::from("."));
    let first = create(&context, "First").await;
    let second = create(&context, "Second").await;
    let linked = update(&context, json!({"taskId":second,"addBlockedBy":[first]})).await;
    assert_eq!(linked["task"]["blockedBy"], json!([first]));
    assert_eq!(linked["tasks"][0]["blocks"], json!([second]));
    let deleted = update(&context, json!({"taskId":first,"status":"deleted"})).await;
    assert_eq!(deleted["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(deleted["tasks"][0]["blockedBy"], json!([]));
    update(&context, json!({"taskId":second,"status":"in_progress"})).await;
}

#[tokio::test]
async fn duplicate_edges_are_idempotent_and_missing_or_self_edges_are_atomic() {
    let context = ToolContext::new(std::path::PathBuf::from("."));
    let a = create(&context, "A").await;
    let b = create(&context, "B").await;
    let once = update(&context, json!({"taskId":b,"addBlockedBy":[a,a]})).await;
    assert_eq!(
        once,
        update(&context, json!({"taskId":b,"addBlockedBy":[a]})).await
    );
    rejects_unchanged(
        &context,
        json!({"taskId":a,"addBlocks":[b,"missing"]}),
        "unknown task",
    )
    .await;
    rejects_unchanged(&context, json!({"taskId":a,"addBlocks":[a]}), "itself").await;
}

#[tokio::test]
async fn dependency_validation_does_not_cross_task_scopes() {
    let first = ToolContext::new(std::path::PathBuf::from("."));
    let second =
        ToolContext::new(std::path::PathBuf::from(".")).with_tasks(first.tasks.clone(), "second");
    let a = create(&first, "A").await;
    let b = create(&first, "B").await;
    create(&second, "unrelated").await;
    rejects_unchanged(
        &second,
        json!({"taskId":a,"addBlockedBy":[b]}),
        "unknown task",
    )
    .await;
    assert_eq!(
        TaskListTool.execute(&first, json!({})).await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
