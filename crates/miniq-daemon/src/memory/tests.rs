use super::*;
use miniq_models::{mock::MockProvider, ChatDelta};
use miniq_protocol::{MemorySettings, MemoryWriteParams, Role};
use serde_json::json;

fn fixture(provider: Arc<MockProvider>) -> (AppState, String, String) {
    let state = AppState::new(
        miniq_memory::Store::open_in_memory().unwrap(),
        "test".into(),
        provider,
    );
    let ws = state
        .store
        .create_workspace("D:/memory-test", "memory")
        .unwrap();
    let chat = state.store.create_session(&ws.id, "memory").unwrap();
    (state, ws.id, chat.id)
}
fn request() -> CompletionRequest {
    CompletionRequest {
        context_compact_threshold: Some(10000),
        trace: Default::default(),
        messages: vec![
            ChatMessage::system("system"),
            ChatMessage::user("写一份报告"),
        ],
        tools: vec![],
        temperature: None,
        max_output_tokens: None,
    }
}
fn save(state: &AppState) -> miniq_protocol::MemoryRecord {
    let p: MemoryWriteParams = serde_json::from_value(
        json!({"target":{"scope":"global"},"content":"工作报告先给结论","kind":"preference"}),
    )
    .unwrap();
    state.store.write_memory(&p, None).unwrap().memory.unwrap()
}
#[tokio::test]
async fn memory_recall_only_enters_task_wire_requests_and_deletion_revalidates() {
    let mock = Arc::new(MockProvider::new(vec![vec![], vec![], vec![]]));
    let (state, _, session) = fixture(mock.clone());
    let row = save(&state);
    let provider = MemoryProvider::new(
        mock.clone(),
        state.clone(),
        &session,
        "报告",
        state.store.memory_generation().unwrap(),
    )
    .unwrap();
    let original = request();
    let _ = provider.stream_complete(original.clone()).await.unwrap();
    let mut summary = original.clone();
    summary.trace.purpose = ModelCallPurpose::Compaction;
    let _ = provider.stream_complete(summary).await.unwrap();
    state
        .store
        .delete_memory(&miniq_protocol::MemoryDeleteParams {
            target: miniq_protocol::MemoryTarget::Global {},
            id: row.id,
            expected_updated_at: row.updated_at,
            expected_content: row.content,
        })
        .unwrap();
    let _ = provider.stream_complete(original.clone()).await.unwrap();
    let calls = mock.requests.lock().unwrap();
    assert!(calls[0]
        .messages
        .iter()
        .any(|m| m.content.contains("工作报告先给结论")));
    assert!(calls[0].context_compact_threshold.is_none());
    for call in &calls[1..] {
        assert!(!call
            .messages
            .iter()
            .any(|m| m.content.contains("工作报告先给结论")));
    }
    assert_eq!(original.messages.len(), 2);
}
#[tokio::test]
async fn memory_is_used_by_real_turn_but_not_saved_in_snapshot() {
    let mock = Arc::new(MockProvider::text("报告已完成。"));
    let (state, _, session) = fixture(mock.clone());
    save(&state);
    state
        .store
        .append_message(&session, Role::User, "写报告")
        .unwrap();
    let mut events = state.events.subscribe();
    let cancel = state.begin_turn(&session).unwrap();
    crate::turn::spawn_turn(state.clone(), session.clone(), cancel);
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match events.recv().await.unwrap() {
                miniq_protocol::Event::TurnCompleted { .. } => break,
                miniq_protocol::Event::TurnFailed { error, .. } => panic!("{error}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let requests = mock.requests.lock().unwrap();
    assert!(requests[0]
        .messages
        .iter()
        .any(|m| m.content.contains("工作报告先给结论")));
    let snapshot = state.store.get_model_context(&session).unwrap().unwrap();
    assert!(!snapshot.history.to_string().contains("工作报告先给结论"));
}
#[tokio::test]
async fn memory_extraction_respects_approval_and_uses_source_evidence() {
    let mock = Arc::new(MockProvider::text(
        r#"[{"content":"工作报告先给结论","kind":"preference","key":"user.report.order","evidence":"以后工作报告先给结论"}]"#,
    ));
    let (state, ws, session) = fixture(mock.clone());
    state
        .store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    state
        .store
        .append_message(&session, Role::User, "以后工作报告先给结论")
        .unwrap();
    state
        .store
        .record_turn_outcome(&session, "completed", None)
        .unwrap();
    let job = state.store.claim_memory_job().unwrap().unwrap();
    state.settings.lock().unwrap().approval_mode = miniq_protocol::ApprovalMode::AlwaysAsk;
    assert!(worker::process(&state, &job).await.is_err());
    assert!(mock.requests.lock().unwrap().is_empty());
    state.settings.lock().unwrap().approval_mode = miniq_protocol::ApprovalMode::Auto;
    worker::process(&state, &job).await.unwrap();
    let rows = state.store.search_memories(Some(&ws), "报告", 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].origin, "extracted");
    assert_eq!(rows[0].scope, "workspace");
    assert_eq!(
        mock.requests.lock().unwrap()[0].trace.purpose,
        ModelCallPurpose::MemoryExtraction
    );
    assert!(state.store.claim_memory_job().unwrap().is_none());
}
#[tokio::test]
async fn memory_extraction_invalid_evidence_never_advances_or_saves() {
    let mock = Arc::new(MockProvider::new(vec![vec![ChatDelta::Text(
        r#"[{"content":"已完成发布","kind":"fact","key":"release","evidence":"任务成功"}]"#.into(),
    )]]));
    let (state, ws, session) = fixture(mock);
    state
        .store
        .update_memory_settings(&MemorySettings {
            recall_enabled: true,
            auto_save: true,
        })
        .unwrap();
    state
        .store
        .append_message(&session, Role::User, "项目使用 Rust")
        .unwrap();
    state
        .store
        .record_turn_outcome(&session, "completed", None)
        .unwrap();
    let job = state.store.claim_memory_job().unwrap().unwrap();
    assert!(worker::process(&state, &job).await.is_err());
    assert!(state
        .store
        .search_memories(Some(&ws), "", 10)
        .unwrap()
        .is_empty());
    state.store.commit_memory_job(&job, &[]).unwrap();
}

#[tokio::test]
async fn memory_project_tool_refreshes_live_state_and_obeys_source_opt_out() {
    use miniq_models::{ProviderContext, ToolCallRequest};
    use miniq_protocol::{PlanTask, PlanTaskStatus, SessionMemorySettings};
    use miniq_tools::Tool;

    let mock = Arc::new(MockProvider::new(vec![vec![], vec![], vec![]]));
    let (state, workspace, session) = fixture(mock.clone());
    let source = state.store.create_session(&workspace, "交付报告").unwrap();
    let mut plan = vec![PlanTask {
        content: "交付报告".into(),
        status: PlanTaskStatus::Pending,
    }];
    state.store.set_session_plan(&source.id, &plan).unwrap();
    let ctx = miniq_tools::ToolContext::new("D:/memory-test".into()).with_memory(
        Some(state.store.clone()),
        Some(workspace),
        Some(session.clone()),
    );
    let args = json!({"sourceSessionId":source.id});
    let result = miniq_tools::MemoryProjectReadTool
        .execute(&ctx, args.clone())
        .await
        .unwrap();
    let mut call = ChatMessage::assistant("");
    call.tool_calls.push(ToolCallRequest {
        id: "project".into(),
        name: "memory_project_read".into(),
        arguments: args.clone(),
    });
    let mut original = request();
    original.messages.extend([
        call,
        ChatMessage::tool_result("project", result.to_string()),
    ]);
    let mut private = ChatMessage::assistant("state inspected");
    private.provider_context = Some(ProviderContext {
        protocol: miniq_protocol::ApiProtocol::Responses,
        data: json!({"encrypted":"private"}),
    });
    original.messages.push(private);
    let provider = MemoryProvider::for_tools(
        mock.clone(),
        state.clone(),
        &session,
        state.store.memory_generation().unwrap(),
    );
    let _ = provider.stream_complete(original.clone()).await.unwrap();
    plan[0].status = PlanTaskStatus::Completed;
    state.store.set_session_plan(&source.id, &plan).unwrap();
    let _ = provider.stream_complete(original.clone()).await.unwrap();
    state
        .store
        .update_session_memory_settings(&SessionMemorySettings {
            session_id: source.id,
            enabled: false,
        })
        .unwrap();
    assert!(miniq_tools::MemoryProjectReadTool
        .execute(&ctx, args)
        .await
        .is_err());
    let _ = provider.stream_complete(original).await.unwrap();
    let requests = mock.requests.lock().unwrap();
    let summaries = requests
        .iter()
        .map(|request| {
            let message = request
                .messages
                .iter()
                .find(|m| m.tool_call_id.as_deref() == Some("project"))
                .unwrap();
            serde_json::from_str::<serde_json::Value>(&message.content).unwrap()["projectSummary"]
                .clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(summaries[0]["plan"][0]["status"], "pending");
    assert_eq!(summaries[1]["plan"][0]["status"], "completed");
    assert!(summaries[2].is_null());
    assert!(requests[2]
        .messages
        .iter()
        .all(|m| m.provider_context.is_none()));
}
