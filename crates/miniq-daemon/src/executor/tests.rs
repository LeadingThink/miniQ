use super::*;

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
        name: "Bash".to_string(),
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
    assert_eq!(output["error"]["requestedTool"], "Bash");
    let available = output["error"]["availableTools"].as_array().unwrap();
    assert!(available.iter().any(|name| name == "shell_run"));
    assert!(available.iter().any(|name| name == "file_read"));
    assert!(!available.iter().any(|name| name == "Bash"));
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
    };
    let output = executor
        .execute(&ToolCallRequest {
            id: "provider-call".to_string(),
            name: "ToolSearch".to_string(),
            arguments: json!({"query": "files"}),
        })
        .await
        .unwrap();

    assert_eq!(output["error"]["code"], "unknown_tool");
    let calls = state.store.list_tool_calls(&session.id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].tool_name, "ToolSearch");
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
        Event::ToolCallStarted { tool_name, .. } if tool_name == "ToolSearch"
    ));
    assert!(matches!(
        finished,
        Event::ToolCallFinished {
            status: ToolCallStatus::Failed,
            ..
        }
    ));
}
