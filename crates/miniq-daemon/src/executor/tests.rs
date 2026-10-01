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

    let output = unknown_tool_output(
        router.specs().into_iter().map(|spec| spec.name).collect(),
        &call,
        &error,
    );

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
        review_plan: Default::default(),
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
        Event::ToolCallStarted { tool_name, created_at, .. }
            if tool_name == "ImaginaryProviderTool" && created_at.as_ref() == Some(&calls[0].created_at)
    ));
    assert!(matches!(
        finished,
        Event::ToolCallFinished {
            status: ToolCallStatus::Failed,
            completed_at,
            ..
        } if completed_at == calls[0].completed_at
    ));
}

struct PluginWireProbe;

#[async_trait::async_trait]
impl miniq_tools::Tool for PluginWireProbe {
    fn name(&self) -> &str {
        "dev.miniq.fixture.run"
    }

    fn description(&self) -> &str {
        "Plugin wire-name probe"
    }

    fn parameters_schema(&self) -> Value {
        json!({"type":"object"})
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> miniq_sandbox::Risk {
        miniq_sandbox::Risk {
            level: RiskLevel::Low,
            reason: "test".into(),
        }
    }

    async fn execute(
        &self,
        _ctx: &ToolContext,
        _input: Value,
    ) -> Result<Value, miniq_tools::ToolError> {
        Ok(json!({"characters": 11, "words": 2, "lines": 1}))
    }
}

#[tokio::test]
async fn provider_wire_name_executes_registered_plugin_tool() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "plugin call").unwrap();
    let state = AppState::new(
        store,
        "token".to_string(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    state
        .router
        .register_builtin(std::sync::Arc::new(PluginWireProbe))
        .unwrap();
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: session.id.clone(),
        router: state.router.clone(),
        ctx: ToolContext::new(directory.path().to_path_buf()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
        review_plan: Default::default(),
    };
    let wire_call = ToolCallRequest {
        id: "provider-call".into(),
        name: "dev_miniq_fixture_run".into(),
        arguments: json!({"text":"Hello miniQ"}),
    };

    let output = executor.execute(&wire_call).await.unwrap();

    assert_eq!(output["words"], 2);
    assert_eq!(
        executor.call_fingerprint(&wire_call),
        executor.call_fingerprint(&ToolCallRequest {
            name: "dev.miniq.fixture.run".into(),
            ..wire_call
        })
    );
    let calls = state.store.list_tool_calls(&session.id).unwrap();
    assert_eq!(calls[0].tool_name, "dev.miniq.fixture.run");
    assert_eq!(calls[0].status, ToolCallStatus::Succeeded);
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
        review_plan: Default::default(),
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
        review_plan: Default::default(),
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
        review_plan: Default::default(),
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

struct DesktopProbe;

#[async_trait::async_trait]
impl miniq_tools::Tool for DesktopProbe {
    fn name(&self) -> &str {
        "computer_use"
    }
    fn description(&self) -> &str {
        "Approval probe, never touches the desktop"
    }
    fn parameters_schema(&self) -> Value {
        json!({"type":"object"})
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> miniq_sandbox::Risk {
        miniq_tools::ComputerUseTool::default().evaluate_risk(ctx, input)
    }
    async fn execute(
        &self,
        _ctx: &ToolContext,
        _input: Value,
    ) -> Result<Value, miniq_tools::ToolError> {
        panic!("unapproved desktop operation must never reach the backend");
    }
}

#[tokio::test]
async fn unapproved_desktop_operations_never_reach_the_backend() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "test")
        .unwrap();
    let session = store
        .create_session(&workspace.id, "approval gate")
        .unwrap();
    let state = AppState::new(
        store,
        "test".into(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    let router = std::sync::Arc::new(miniq_tools::ToolRouter::new());
    router
        .register_builtin(std::sync::Arc::new(DesktopProbe))
        .unwrap();
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: session.id.clone(),
        router,
        ctx: ToolContext::new(directory.path().into()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::DontAsk,
        review_plan: Default::default(),
    };
    for action in ["screenshot", "click", "type", "key", "drag", "scroll"] {
        let output = executor
            .execute(&ToolCallRequest {
                id: action.into(),
                name: "computer_use".into(),
                arguments: json!({"action":action}),
            })
            .await
            .unwrap();
        assert_eq!(output["rejected"], true);
        assert!(executor
            .result_images(
                &ToolCallRequest {
                    id: action.into(),
                    name: "computer_use".into(),
                    arguments: json!({}),
                },
                &output
            )
            .is_empty());
    }
    assert!(state
        .store
        .list_tool_calls(&session.id)
        .unwrap()
        .iter()
        .all(|call| call.status == ToolCallStatus::Rejected));
}

#[test]
fn native_visual_results_resolve_the_same_tool_as_execution() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(
        miniq_memory::Store::open_in_memory().unwrap(),
        "fixture".into(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    let executor = SessionToolExecutor {
        state,
        session_id: "fixture".into(),
        router: std::sync::Arc::new(miniq_tools::default_router()),
        ctx: ToolContext::new(directory.path().into()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
        review_plan: Default::default(),
    };
    let screenshot = json!({"id":"aa8091e1-3bf0-4b0f-b699-260f2ac9e081"});
    for (path, output) in [
        ("image.png", json!({"screenshot":screenshot})),
        (
            "scan.pdf",
            json!({"pages":[{"page":1,"screenshot":screenshot}]}),
        ),
    ] {
        let call = ToolCallRequest {
            id: "read".into(),
            name: "Read".into(),
            arguments: json!({"file_path":path}),
        };
        assert_eq!(executor.result_images(&call, &output).len(), 1, "{path}");
    }
}

#[test]
fn parallel_execution_keeps_native_and_canonical_mutations_as_barriers() {
    let state = AppState::new(
        miniq_memory::Store::open_in_memory().unwrap(),
        "fixture".into(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    let executor = SessionToolExecutor {
        router: state.router.clone(),
        state,
        session_id: "fixture".into(),
        ctx: ToolContext::new(std::env::temp_dir()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
        review_plan: Default::default(),
    };
    for name in [
        "file_read",
        "Read",
        "doc_read",
        "file_grep",
        "Grep",
        "git_diff",
    ] {
        assert_eq!(
            executor.execution_mode(&ToolCallRequest {
                id: name.into(),
                name: name.into(),
                arguments: json!({}),
            }),
            ToolExecutionMode::Parallel,
            "{name}"
        );
    }
    for name in [
        "file_write",
        "Write",
        "Edit",
        "Bash",
        "shell_batch",
        "browser_automation",
        "app_automation",
        "computer_use",
        "ask_user",
        "agent_run",
        "Task",
        "mcp_call",
        "unknown",
    ] {
        assert_eq!(
            executor.execution_mode(&ToolCallRequest {
                id: name.into(),
                name: name.into(),
                arguments: json!({}),
            }),
            ToolExecutionMode::Sequential,
            "{name}"
        );
    }
}

fn effective_set_fixture(
    policy: PermissionPolicy,
    servers: Vec<crate::mcp::McpServerConfig>,
) -> (tempfile::TempDir, AppState, SessionToolExecutor) {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "effective").unwrap();
    let state = AppState::new(
        store,
        "token".to_string(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    state.settings.lock().unwrap().mcp_servers = servers;
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: session.id.clone(),
        router: state.router.clone(),
        ctx: ToolContext::new(directory.path().to_path_buf()),
        cancel: CancellationToken::new(),
        permission_policy: policy,
        review_plan: Default::default(),
    };
    (directory, state, executor)
}

fn mcp_server(name: &str, enabled: bool) -> crate::mcp::McpServerConfig {
    crate::mcp::McpServerConfig {
        name: name.into(),
        command: "/nonexistent/mcp".into(),
        args: Vec::new(),
        enabled,
        env: Default::default(),
    }
}

fn mcp_call_request(server: &str) -> ToolCallRequest {
    ToolCallRequest {
        id: "mcp-call".into(),
        name: "mcp_call".into(),
        arguments: json!({"server": server, "tool": "echo", "arguments": {"message": "hi"}}),
    }
}

/// RT-07: once a server is disabled, `mcp_call` targeting it is checked on
/// the inner (server, tool), rejected with TOOL_NOT_IN_EFFECTIVE_SET and
/// never reaches approval.
#[tokio::test]
async fn rt07_disabled_mcp_server_call_is_rejected_before_approval() {
    let (_dir, state, executor) =
        effective_set_fixture(PermissionPolicy::Inherit, vec![mcp_server("mock", false)]);
    state.settings.lock().unwrap().approval_mode = miniq_protocol::ApprovalMode::AlwaysAsk;
    let mut events = state.events.subscribe();

    assert!(!executor.specs().iter().any(|spec| spec.name == "mcp_call"));
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        executor.execute(&mcp_call_request("mock")),
    )
    .await
    .expect("must not wait for approval")
    .unwrap();

    assert_eq!(output["error"]["code"], "TOOL_NOT_IN_EFFECTIVE_SET");
    assert_eq!(output["error"]["requestedTool"], "mcp:mock:echo");
    let calls = state.store.list_tool_calls(&executor.session_id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].status, ToolCallStatus::Failed);
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(event, Event::ApprovalRequested { .. }),
            "rejected call must skip approval"
        );
    }
}

#[tokio::test]
async fn mcp_call_to_unconfigured_server_is_rejected_even_when_others_enabled() {
    let (_dir, _state, executor) =
        effective_set_fixture(PermissionPolicy::Inherit, vec![mcp_server("mock", true)]);
    assert!(executor.specs().iter().any(|spec| spec.name == "mcp_call"));
    let output = executor.execute(&mcp_call_request("other")).await.unwrap();
    assert_eq!(output["error"]["code"], "TOOL_NOT_IN_EFFECTIVE_SET");
    assert_eq!(output["error"]["requestedTool"], "mcp:other:echo");
}

#[tokio::test]
async fn mcp_call_without_servers_is_outside_the_effective_set() {
    let (_dir, _state, executor) = effective_set_fixture(PermissionPolicy::Inherit, Vec::new());
    assert!(!executor.specs().iter().any(|spec| spec.name == "mcp_call"));
    let output = executor.execute(&mcp_call_request("mock")).await.unwrap();
    assert_eq!(output["error"]["code"], "TOOL_NOT_IN_EFFECTIVE_SET");
    assert_eq!(output["error"]["requestedTool"], "mcp:mock:echo");
}

/// Plugin MCP servers are available by default while their plugin is
/// enabled and leave the effective set when it is disabled.
#[tokio::test]
async fn plugin_mcp_servers_join_the_effective_set_while_enabled() {
    let (_dir, state, executor) = effective_set_fixture(PermissionPolicy::Inherit, Vec::new());
    let source_root = tempfile::tempdir().unwrap();
    let source = source_root.path().join("source");
    std::fs::create_dir_all(source.join("linear")).unwrap();
    std::fs::write(
        source.join("manifest.toml"),
        r#"id = "dev.miniq.linear"
name = "Linear"
version = "1.0.0"
api_version = "1.0.0"
runtime = "skills"
capabilities = ["skills"]
skills = ["linear"]

[[mcp_servers]]
name = "linear"
command = "/nonexistent/mcp"
"#,
    )
    .unwrap();
    std::fs::write(
        source.join("linear/SKILL.md"),
        "---\nname: linear\ndescription: Linear workflow\n---\n",
    )
    .unwrap();
    state.plugins.install_from_directory(&source).await.unwrap();

    assert!(executor.specs().iter().any(|spec| spec.name == "mcp_call"));
    assert!(executor
        .effective_set()
        .contains_mcp("linear", "tools/list"));
    assert_eq!(state.effective_mcp_servers().len(), 1);

    state
        .plugins
        .set_enabled("dev.miniq.linear", false, false)
        .await
        .unwrap();
    assert!(!executor.specs().iter().any(|spec| spec.name == "mcp_call"));
    let output = executor.execute(&mcp_call_request("linear")).await.unwrap();
    assert_eq!(output["error"]["code"], "TOOL_NOT_IN_EFFECTIVE_SET");
    assert!(state.mcp_bridge().is_none());
}

/// An in-set `mcp_call` goes through `decide_approval`: under DontAsk with an
/// always-ask session it is denied without prompting; under Inherit it asks.
#[tokio::test]
async fn enabled_mcp_call_goes_through_decide_approval() {
    let (_dir, state, executor) =
        effective_set_fixture(PermissionPolicy::DontAsk, vec![mcp_server("mock", true)]);
    state.settings.lock().unwrap().approval_mode = miniq_protocol::ApprovalMode::AlwaysAsk;
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        executor.execute(&mcp_call_request("mock")),
    )
    .await
    .expect("DontAsk must not wait")
    .unwrap();
    assert_eq!(output["rejected"], true, "{output}");

    let (_dir, state, executor) =
        effective_set_fixture(PermissionPolicy::Inherit, vec![mcp_server("mock", true)]);
    state.settings.lock().unwrap().approval_mode = miniq_protocol::ApprovalMode::AlwaysAsk;
    let mut events = state.events.subscribe();
    let task = tokio::spawn(async move { executor.execute(&mcp_call_request("mock")).await });
    let approval = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Event::ApprovalRequested { approval, .. } = events.recv().await.unwrap() {
                break approval;
            }
        }
    })
    .await
    .expect("mcp_call must request approval");
    assert!(state.deliver_approval(&approval.id, ApprovalDecision::Reject));
    let output = task.await.unwrap().unwrap();
    assert_eq!(output["rejected"], true, "{output}");
}

#[tokio::test]
async fn unregistered_tool_is_not_in_effective_set_and_unknown_output_uses_it() {
    let (_dir, _state, executor) = effective_set_fixture(PermissionPolicy::Inherit, Vec::new());
    let output = executor
        .execute(&ToolCallRequest {
            id: "ghost".into(),
            name: "ghost_tool".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    assert_eq!(output["error"]["code"], "unknown_tool");
    let available = output["error"]["availableTools"].as_array().unwrap();
    assert!(!available.iter().any(|name| name == "mcp_call"));
}

#[cfg(unix)]
#[tokio::test]
async fn pre_tool_use_hook_exit_2_blocks_the_tool() {
    let directory = tempfile::tempdir().unwrap();
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = store.create_session(&workspace.id, "hooked").unwrap();
    std::fs::write(directory.path().join("note.txt"), "secret").unwrap();
    let state = AppState::new(
        store,
        "token".to_string(),
        std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
    );
    state.settings.lock().unwrap().hooks = vec![crate::hooks::HookConfig {
        event: "preToolUse".into(),
        matcher: Some("file_.*".into()),
        command: "cat > hook-stdin.json; echo no reading >&2; exit 2".into(),
        timeout_secs: Some(10),
        enabled: None,
    }];
    let executor = SessionToolExecutor {
        state: state.clone(),
        session_id: session.id.clone(),
        router: state.router.clone(),
        ctx: ToolContext::new(directory.path().to_path_buf()),
        cancel: CancellationToken::new(),
        permission_policy: PermissionPolicy::Inherit,
        review_plan: Default::default(),
    };
    let output = executor
        .execute(&ToolCallRequest {
            id: "provider-call".to_string(),
            name: "file_read".to_string(),
            arguments: json!({"path": "note.txt"}),
        })
        .await
        .unwrap();

    assert_eq!(output["error"], "Blocked by preToolUse hook: no reading");
    let calls = state.store.list_tool_calls(&session.id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].status, ToolCallStatus::Failed);
    let stdin: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.path().join("hook-stdin.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stdin["hookEvent"], "preToolUse");
    assert_eq!(stdin["toolName"], "file_read");
    assert_eq!(stdin["toolInput"]["path"], "note.txt");
    assert_eq!(stdin["sessionId"], session.id);
}
