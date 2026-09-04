use super::*;
use std::time::Duration;

#[tokio::test]
async fn unattended_question_uses_default_after_timeout() {
    let (_sender, receiver) = tokio::sync::oneshot::channel();
    let result = wait_for_question_answer(
        receiver,
        &CancellationToken::new(),
        Some((Duration::from_millis(1), "继续".to_string())),
    )
    .await
    .unwrap();

    assert_eq!(result, ("继续".to_string(), true));
}

#[test]
fn unattended_default_prefers_explicit_then_first_option() {
    let explicit = ToolCallRequest {
        id: "call".to_string(),
        name: "ask_user".to_string(),
        arguments: json!({"prompt": "?", "default": "安全方案"}),
    };
    assert_eq!(
        unattended_default(&explicit, &["第一项".to_string()]),
        "安全方案"
    );

    let first = ToolCallRequest {
        id: "call".to_string(),
        name: "ask_user".to_string(),
        arguments: json!({"prompt": "?"}),
    };
    assert_eq!(
        unattended_default(&first, &["第一项".to_string()]),
        "第一项"
    );
}

#[test]
fn unknown_tool_response_lists_real_tools_and_recovery_guidance() {
    let router = miniq_tools::default_router();
    let call = ToolCallRequest {
        id: "call".to_string(),
        name: "ImaginaryProviderTool".to_string(),
        arguments: json!({"command": "pwd"}),
    };
    let error = router
        .evaluate(
            &ToolContext::new(std::path::PathBuf::from("workspace")),
            &call.name,
            &call.arguments,
        )
        .unwrap_err();

    let output = unknown_tool_output(&router, &call, &error);

    assert_eq!(output["error"]["code"], "unknown_tool");
    assert_eq!(output["error"]["requestedTool"], "ImaginaryProviderTool");
    let available = output["error"]["availableTools"].as_array().unwrap();
    assert!(available.iter().any(|name| name == "shell_run"));
    assert!(available.iter().any(|name| name == "file_read"));
    assert!(available.iter().any(|name| name == "tool_search"));
}

#[tokio::test]
async fn unknown_tool_is_persisted_and_emits_a_failed_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "unknown tool").unwrap();
    let state = AppState::new(
        store,
        "token".to_string(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    let mut events = state.events.subscribe();
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: session.id.clone(),
        router: state.router.clone(),
        ctx: ToolContext::new(directory.path().to_path_buf()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
    };
    let output = executor
        .execute(&ToolCallRequest {
            id: "provider-call".to_string(),
            name: "ImaginaryProviderTool".to_string(),
            arguments: json!({"query": "files"}),
        })
        .await
        .unwrap();

    assert_eq!(output["error"]["code"], "unknown_tool");
    let calls = state.store.list_tool_calls(&session.id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].tool_name, "ImaginaryProviderTool");
    assert_eq!(calls[0].status, ToolCallStatus::Failed);
    assert_eq!(
        calls[0].output.as_ref().unwrap()["error"]["code"],
        "unknown_tool"
    );
    assert!(calls[0].completed_at.is_some());
    assert_eq!(state.store.count_audit_events(&session.id).unwrap(), 1);

    let started = events.recv().await.unwrap();
    let finished = events.recv().await.unwrap();
    assert!(matches!(
        started,
        Event::ToolCallStarted { tool_name, .. } if tool_name == "ImaginaryProviderTool"
    ));
    assert!(matches!(
        finished,
        Event::ToolCallFinished {
            status: ToolCallStatus::Failed,
            ..
        }
    ));
}

#[test]
fn native_write_is_risk_checked_as_the_canonical_write_tool() {
    let directory = tempfile::tempdir().unwrap();
    let router = miniq_tools::default_router();
    let native = ToolCallRequest {
        id: "provider-call".into(),
        name: "Write".into(),
        arguments: json!({"file_path":"new.txt","content":"hello"}),
    };
    let adapted = miniq_tools::adapt_native_tool_call(&native)
        .unwrap()
        .unwrap();

    let risk = router
        .evaluate(
            &ToolContext::new(directory.path().to_path_buf()),
            &adapted.call.name,
            &adapted.call.arguments,
        )
        .unwrap();
    assert_eq!(adapted.call.name, "file_write");
    assert_eq!(risk.level, RiskLevel::Medium);
}

#[test]
fn native_alias_and_canonical_call_share_a_loop_fingerprint() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let state = AppState::new(
        store,
        "token".to_string(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: "session".into(),
        router: state.router.clone(),
        ctx: ToolContext::new(directory.path().to_path_buf()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
    };
    let native = ToolCallRequest {
        id: "native".into(),
        name: "Read".into(),
        arguments: json!({"file_path":"README.md"}),
    };
    let canonical = ToolCallRequest {
        id: "canonical".into(),
        name: "file_read".into(),
        arguments: json!({"path":"README.md"}),
    };

    assert_eq!(
        executor.call_fingerprint(&native),
        executor.call_fingerprint(&canonical)
    );
}

#[tokio::test]
async fn native_tool_search_executes_instead_of_returning_unknown_tool() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "tool search").unwrap();
    let state = AppState::new(
        store,
        "token".to_string(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: session.id.clone(),
        router: state.router.clone(),
        ctx: ToolContext::new(directory.path().to_path_buf()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
    };

    let output = executor
        .execute(&ToolCallRequest {
            id: "provider-call".into(),
            name: "ToolSearch".into(),
            arguments: json!({"query":"select:Read,Bash"}),
        })
        .await
        .unwrap();

    assert_eq!(output["total"], 2);
    let calls = state.store.list_tool_calls(&session.id).unwrap();
    assert_eq!(calls[0].tool_name, "tool_search");
    assert_eq!(calls[0].status, ToolCallStatus::Succeeded);
    assert_eq!(state.store.count_audit_events(&session.id).unwrap(), 2);
}

#[tokio::test]
async fn plan_mode_blocks_workspace_writes_until_exit() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "plan mode").unwrap();
    let state = AppState::new(
        store,
        "token".into(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    let ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.set_plan_mode(true);
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: session.id,
        router: state.router.clone(),
        ctx,
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
    };

    let output = executor
        .execute(&ToolCallRequest {
            id: "write-in-plan".into(),
            name: "file_write".into(),
            arguments: json!({"path":"blocked.txt","content":"no"}),
        })
        .await
        .unwrap();

    assert_eq!(output["rejected"], true);
    assert!(!directory.path().join("blocked.txt").exists());
}
