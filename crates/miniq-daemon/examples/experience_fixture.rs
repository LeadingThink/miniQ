//! Isolated UI fixture: no installed app, production settings, or paid model.
//! cargo run -p miniq-daemon --example experience_fixture
use axum::{routing::get, Json};
use miniq_daemon::{server, state::AppState};
use miniq_memory::Store;
use miniq_models::{mock::MockProvider, ApiProtocol, ChatDelta, ProviderConfig, ToolCallRequest};
use miniq_protocol::{PlanTask, PlanTaskStatus, Role, ToolCallStatus};
use serde_json::json;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace_dir = tempfile::tempdir()?;
    let workspace_path = workspace_dir.path().to_str().unwrap();
    let markdown = workspace_dir.path().join("report.md");
    let html = workspace_dir.path().join("preview.html");
    std::fs::write(
        &markdown,
        include_str!("../../../docs/experience-improvement-ledger.md"),
    )?;
    std::fs::write(&html, include_str!("experience_preview.html"))?;
    let store = Store::open_in_memory()?;
    let workspace = store.create_workspace(workspace_path, "Experience QA")?;
    let session = store.create_session(&workspace.id, "Long task and preview inspection")?;
    store.create_session(&workspace.id, "Independent model settings")?;
    store.append_message(
        &session.id,
        Role::User,
        "检查长任务的执行记录、模型设置和预览结果。",
    )?;
    seed_tools(&store, &session.id, 18, false)?;
    store.append_message(
        &session.id,
        Role::Assistant,
        "已完成第一阶段，继续检查错误处理和文件预览。",
    )?;
    seed_tools(&store, &session.id, 5, true)?;
    store.append_message(&session.id, Role::Assistant, "## 检查结果\n\n已整理执行证据。\n\n| 模块 | 结果 |\n| --- | --- |\n| 会话配置 | 独立保存 |\n| 工具输出 | 完整保留 |\n| 文件预览 | 可交互 |\n\n[Markdown 报告](report.md) · [HTML 预览](preview.html)")?;
    store.set_session_plan(
        &session.id,
        &[
            PlanTask {
                content: "检查会话与模型隔离".into(),
                status: PlanTaskStatus::Completed,
            },
            PlanTask {
                content: "验证执行记录和文件预览".into(),
                status: PlanTaskStatus::Completed,
            },
        ],
    )?;
    store.create_artifact(
        &session.id,
        markdown.to_str().unwrap(),
        "markdown",
        "Experience report",
    )?;
    store.create_artifact(
        &session.id,
        html.to_str().unwrap(),
        "html",
        "Interactive preview",
    )?;
    let listener = server::bind(0).await?;
    let port = listener.local_addr()?.port();
    let provider = MockProvider::new(vec![
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "qa-child".into(),
            name: "agent_run".into(),
            arguments: json!({"prompt":"Inspect fixture","description":"Preview and model verification","name":"inspector"}),
        })],
        vec![ChatDelta::Text(
            "Child inspection finished. Full evidence is available.".into(),
        )],
        vec![ChatDelta::Text("Delegated inspection completed.".into())],
    ]);
    let state = AppState::new(store, "experience-test-only".into(), Arc::new(provider));
    state.settings.lock().unwrap().provider = Some(ProviderConfig {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        api_key: String::new(),
        model: "gpt-5.6-sol".into(),
        api_protocol: ApiProtocol::Auto,
        reasoning_effort: None,
    });
    let shutdown = state.shutdown.clone();
    let router = server::router(state)
        .route("/v1/models", get(|| async { Json(json!({"data":[{"id":"gpt-5.6-sol"},{"id":"claude-sonnet-4.6"},{"id":"gemini-3.1-pro"},{"id":"deepseek-v4-pro"},{"id":"grok-4.6"}]})) }))
        .route("/v1/models/{model}", get(|| async { Json(json!({"data":{"max_tokens":1000000,"max_output":128000}})) }));
    println!("Fixture: ?port={port}&token=experience-test-only");
    println!("Workspace: {workspace_path}");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown.cancelled_owned())
        .await?;
    Ok(())
}

fn seed_tools(store: &Store, session: &str, count: usize, failed: bool) -> anyhow::Result<()> {
    for index in 0..count {
        let call = store.create_tool_call(
            session,
            if failed {
                "custom_validation"
            } else {
                "shell_run"
            },
            &json!({"command":format!("check module {index}")}),
            ToolCallStatus::Running,
        )?;
        let status = if failed && index == 2 {
            ToolCallStatus::Failed
        } else {
            ToolCallStatus::Succeeded
        };
        let output = (0..230)
            .map(|row| format!("module {index}: evidence row {row}"))
            .collect::<Vec<_>>()
            .join("\n");
        store.finish_tool_call(&call.id, status, Some(&json!({"stdout":output,"exitCode":if status == ToolCallStatus::Failed { 1 } else { 0 }})))?;
    }
    Ok(())
}
