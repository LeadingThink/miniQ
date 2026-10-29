use super::*;
use std::sync::Arc;
fn fixture() -> (ToolContext, Arc<miniq_memory::Store>, Value) {
    let store = Arc::new(miniq_memory::Store::open_in_memory().unwrap());
    let workspace = store.create_workspace("/project", "project").unwrap();
    let session = store.create_session(&workspace.id, "chat").unwrap();
    let source = store
        .append_message(
            &session.id,
            miniq_protocol::Role::User,
            "以后工作报告先给结论；项目使用 cargo test",
        )
        .unwrap();
    let ctx = ToolContext::new("/project".into())
        .with_memory(
            Some(store.clone()),
            Some(workspace.id.clone()),
            Some(session.id.clone()),
        )
        .with_memory_source(Some(source.id))
        .with_tasks(Arc::new(crate::tasks::TaskManager::default()), &session.id);
    (
        ctx,
        store,
        json!({"scope":"workspace","workspaceId":workspace.id}),
    )
}
#[tokio::test]
async fn write_search_correct_forget_and_temporary_scope() {
    let (ctx, store, target) = fixture();
    let written = MemoryWriteTool
        .execute(
            &ctx,
            json!({"target":target,"content":"项目使用 cargo test"}),
        )
        .await
        .unwrap();
    assert_eq!(written["status"], "added");
    let results = MemorySearchTool
        .execute(&ctx, json!({"query":"cargo"}))
        .await
        .unwrap();
    assert_eq!(results["memories"].as_array().unwrap().len(), 1);
    let global = MemoryWriteTool
        .execute(
            &ctx,
            json!({"target":{"scope":"global"},"content":"工作报告先给结论","kind":"preference"}),
        )
        .await
        .unwrap();
    assert_eq!(global["memory"]["origin"], "explicit");
    let changed=MemoryWriteTool.execute(&ctx,json!({"target":target,"content":"项目使用 cargo nextest","replaces":{"id":written["memory"]["id"],"expectedRevision":1}})).await.unwrap();
    assert_eq!(changed["status"], "updated");
    let row = &changed["memory"];
    MemoryForgetTool.execute(&ctx,json!({"target":target,"id":row["id"],"expectedContent":row["content"],"expectedUpdatedAt":row["updatedAt"]})).await.unwrap();
    assert_eq!(
        MemorySearchTool
            .execute(&ctx, json!({"query":"nextest"}))
            .await
            .unwrap()["memories"],
        json!([])
    );
    store
        .update_session_memory_settings(&miniq_protocol::SessionMemorySettings {
            session_id: ctx.task_scope.clone(),
            enabled: false,
        })
        .unwrap();
    assert!(MemoryWriteTool
        .execute(&ctx, json!({"target":target,"content":"blocked"}))
        .await
        .is_err());
    assert!(MemorySearchTool
        .execute(&ctx, json!({"query":""}))
        .await
        .is_err());
}
#[tokio::test]
async fn schema_runtime_limits_and_workspace_boundary_match() {
    let (ctx, _store, _target) = fixture();
    for limit in [0, 101] {
        assert!(MemorySearchTool
            .execute(&ctx, json!({"query":"cargo","limit":limit}))
            .await
            .is_err());
    }
    assert_eq!(
        MemorySearchTool.parameters_schema()["properties"]["limit"]["maximum"],
        100.0
    );
    assert!(MemoryWriteTool
        .execute(
            &ctx,
            json!({"target":{"scope":"workspace","workspaceId":"other"},"content":"private"})
        )
        .await
        .is_err());
    assert!(MemoryWriteTool
        .execute(&ctx, json!({"target":{"scope":"session"},"content":"x"}))
        .await
        .is_err());
}
