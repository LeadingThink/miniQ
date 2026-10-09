use super::*;

#[tokio::test]
async fn task_graph_reads_cannot_replace_an_active_checklist() {
    let (_dir, executor) = fixture();
    let created = executor
        .execute(&call(
            "task_create",
            json!({"subject":"old graph","description":"old graph"}),
        ))
        .await
        .unwrap();
    let checklist = json!({"tasks":[task("focused code review", "in_progress")]});
    executor
        .execute(&call("task_update", checklist.clone()))
        .await
        .unwrap();
    for read in [
        call("task_list", json!({})),
        call("task_get", json!({"taskId":created["task"]["id"]})),
    ] {
        executor.execute(&read).await.unwrap();
        assert_eq!(
            json!(executor
                .state
                .store
                .session_plan(&executor.session_id)
                .unwrap()),
            checklist["tasks"]
        );
        assert!(matches!(
            *executor.review_plan.lock().unwrap(),
            Some(ReviewPlan::Checklist)
        ));
    }
}

#[tokio::test]
async fn empty_task_graph_read_preserves_checklist_and_explains_wrong_update() {
    let (_dir, executor) = fixture();
    let checklist = json!({"tasks":[task("focused code review", "in_progress")]});
    executor
        .execute(&call("task_update", checklist.clone()))
        .await
        .unwrap();
    let wrong = executor
        .execute(&call(
            "task_item_update",
            json!({"taskId":"...","status":"completed"}),
        ))
        .await
        .unwrap();
    assert!(wrong["error"]
        .as_str()
        .unwrap()
        .contains("update that checklist with task_update"));
    let listed = executor
        .execute(&call("task_list", json!({})))
        .await
        .unwrap();
    assert_eq!(listed["tasks"], json!([]));
    assert_eq!(
        json!(executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap()),
        checklist["tasks"]
    );
    assert!(matches!(
        *executor.review_plan.lock().unwrap(),
        Some(ReviewPlan::Checklist)
    ));
}

#[tokio::test]
async fn review_cannot_execute_side_effects_or_shrink_rename_reorder_and_downgrade_tasks() {
    let (dir, executor) = fixture();
    let original = json!({"tasks":[task("research", "completed"), task("video", "in_progress")]});
    executor
        .execute(&call("task_update", original.clone()))
        .await
        .unwrap();
    let review = reviewer(&executor);
    for attempted in [
        call(
            "file_write",
            json!({"path":"unexpected.txt","content":"side effect"}),
        ),
        call("task_update", json!({"tasks":[]})),
        call(
            "task_update",
            json!({"tasks":[task("video","completed"),task("research","completed")]}),
        ),
        call(
            "task_update",
            json!({"tasks":[task("renamed","completed"),task("video","completed")]}),
        ),
        call(
            "task_update",
            json!({"tasks":[task("research","pending"),task("video","completed")]}),
        ),
        call(
            "task_update",
            json!({"tasks":[task("research","completed"),task("video","in_progress")]}),
        ),
        call(
            "task_update",
            json!({"tasks":original["tasks"],"extra":true}),
        ),
    ] {
        assert!(
            review
                .execute(&attempted)
                .await
                .unwrap()
                .get("error")
                .is_some(),
            "{}",
            attempted.name
        );
    }
    assert!(!dir.path().join("unexpected.txt").exists());
    assert_eq!(
        json!(executor
            .state
            .store
            .session_plan(&executor.session_id)
            .unwrap()),
        original["tasks"]
    );
    assert_eq!(
        executor
            .state
            .store
            .list_tool_calls(&executor.session_id)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn graph_review_preserves_dependencies_and_rejects_unrelated_mutations() {
    let (_dir, executor) = fixture();
    let a = executor
        .execute(&call(
            "task_create",
            json!({"subject":"research","description":"research evidence"}),
        ))
        .await
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b = executor
        .execute(&call(
            "task_create",
            json!({"subject":"video","description":"video evidence"}),
        ))
        .await
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    executor
        .execute(&call(
            "task_item_update",
            json!({"taskId":b,"addBlockedBy":[a]}),
        ))
        .await
        .unwrap();
    let review = reviewer(&executor);
    assert_eq!(review.specs()[0].name, "task_item_update");
    for attempt in [
        call("task_update", json!({"tasks":[]})),
        call("task_item_update", json!({"taskId":b,"status":"deleted"})),
        call(
            "task_item_update",
            json!({"taskId":b,"status":"completed","subject":"different"}),
        ),
        call(
            "task_item_update",
            json!({"taskId":"unrelated","status":"completed"}),
        ),
    ] {
        assert!(review
            .execute(&attempt)
            .await
            .unwrap()
            .get("error")
            .is_some());
    }
    let blocked = review
        .execute(&call(
            "task_item_update",
            json!({"taskId":b,"status":"completed"}),
        ))
        .await
        .unwrap();
    assert!(blocked.get("error").is_some());
    review
        .execute(&call(
            "TaskUpdate",
            json!({"taskId":a,"status":"completed"}),
        ))
        .await
        .unwrap();
    let result = review
        .execute(&call(
            "task_item_update",
            json!({"taskId":b,"status":"completed"}),
        ))
        .await
        .unwrap();
    assert_eq!(result["task"]["blockedBy"], json!([a]));
    assert!(review
        .execute(&call(
            "task_item_update",
            json!({"taskId":b,"status":"pending"})
        ))
        .await
        .unwrap()
        .get("error")
        .is_some());
    assert!(executor
        .state
        .store
        .session_plan(&executor.session_id)
        .unwrap()
        .iter()
        .all(|task| task.status == PlanTaskStatus::Completed));
}
