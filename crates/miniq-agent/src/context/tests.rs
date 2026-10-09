use super::*;
use miniq_models::{mock::MockProvider, ChatDelta};

#[test]
fn provider_context_contributes_to_context_limits() {
    let mut message = ChatMessage::assistant("");
    message.provider_context = Some(miniq_models::ProviderContext {
        protocol: miniq_models::ApiProtocol::Responses,
        data: serde_json::json!([{"type":"reasoning","encrypted_content":"x".repeat(400)}]),
    });

    assert!(estimate_tokens(&[message]) >= 100);
}

#[tokio::test]
async fn summarizes_old_context_and_preserves_recent_user_turn() {
    let provider = MockProvider::new(vec![vec![ChatDelta::Text("stable summary".into())]]);
    let messages = vec![
        ChatMessage::system("system"),
        ChatMessage::user("old request with many details"),
        ChatMessage::assistant("old answer with many details"),
        ChatMessage::user("recent request"),
        ChatMessage::assistant("recent answer"),
    ];
    let policy = ContextPolicy {
        auto_limit: false,
        soft_limit_tokens: 8,
        preserve_recent_messages: 2,
        prune_tool_results_over_tokens: 2,
        summary_batch_tokens: 100,
    };
    let (events, mut receiver) = tokio::sync::mpsc::channel(4);
    let outcome = compact_history(
        &provider,
        messages,
        &[],
        &policy,
        4,
        &events,
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    assert!(outcome.compacted);
    assert!(outcome.messages[1].content.contains("stable summary"));
    assert_eq!(outcome.messages[2].content, "recent request");
    assert_eq!(provider.requests.lock().unwrap()[0].temperature, None);
    assert!(matches!(
        receiver.recv().await,
        Some(AgentEvent::ModelRequestStarted {
            step: 0,
            retry: None
        })
    ));
    assert!(matches!(
        receiver.recv().await,
        Some(AgentEvent::ModelResponseStarted {
            step: 0,
            retry: None
        })
    ));
    assert!(matches!(
        receiver.recv().await,
        Some(AgentEvent::ContextCompacted { .. })
    ));
}

#[test]
fn tool_schemas_contribute_to_request_estimate() {
    let tools = vec![ToolSpec {
        name: "large_tool".into(),
        description: "x".repeat(600),
        parameters: serde_json::json!({"type":"object"}),
    }];

    assert!(
        estimate_request_tokens(&[ChatMessage::user("work")], &tools)
            > estimate_request_tokens(&[ChatMessage::user("work")], &[]) + 150
    );
}

#[tokio::test]
async fn normal_compaction_uses_one_handoff_and_retains_all_system_policies() {
    let provider = MockProvider::new(vec![vec![ChatDelta::Text("handoff".into())]]);
    let messages = vec![
        ChatMessage::system("stable runtime"),
        ChatMessage::system("task policy"),
        ChatMessage::user("u".repeat(82_000)),
        ChatMessage::assistant("a".repeat(82_000)),
        ChatMessage::user("r".repeat(40_000)),
    ];
    let policy = ContextPolicy {
        preserve_recent_messages: 2,
        ..Default::default()
    };
    let (events, _receiver) = tokio::sync::mpsc::channel(8);
    let outcome = compact_history(
        &provider,
        messages,
        &[],
        &policy,
        1,
        &events,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(outcome.compacted);
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    assert_eq!(outcome.messages[0].content, "stable runtime");
    assert_eq!(outcome.messages[1].content, "task policy");
    assert_eq!(outcome.messages[2].role, ChatRole::Assistant);
    assert!(outcome.messages[2].content.contains("handoff"));
    assert_eq!(outcome.messages[3].content.len(), 40_000);
}

#[tokio::test]
async fn compacts_an_oversized_tool_result_inside_the_recent_window() {
    let provider = MockProvider::new(Vec::new());
    let mut assistant = ChatMessage::assistant("running command");
    assistant.tool_calls.push(miniq_models::ToolCallRequest {
        id: "call-1".into(),
        name: "shell_batch".into(),
        arguments: serde_json::json!({"commands":["rg TODO"]}),
    });
    let messages = vec![
        ChatMessage::system("system"),
        ChatMessage::user("inspect"),
        assistant,
        ChatMessage::tool_result("call-1", "x".repeat(3_200_000)),
    ];
    let policy = ContextPolicy {
        auto_limit: false,
        soft_limit_tokens: 64_000,
        preserve_recent_messages: 16,
        prune_tool_results_over_tokens: 2_000,
        summary_batch_tokens: 32_000,
    };
    let (events, _receiver) = tokio::sync::mpsc::channel(4);

    let outcome = compact_history(
        &provider,
        messages,
        &[],
        &policy,
        4,
        &events,
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    assert!(outcome.compacted);
    assert!(outcome.estimated_tokens_before > 1_000_000);
    assert!(outcome.estimated_tokens_after < policy.soft_limit_tokens);
    assert!(outcome.messages[3]
        .content
        .contains("oversized_tool_result"));
    let archive = outcome
        .messages
        .iter()
        .find_map(|message| message.working_memory.as_ref())
        .expect("compaction keeps the local tool archive")
        .results
        .first()
        .expect("tool result is archived");
    assert_eq!(archive.id, "call-1");
    assert_eq!(archive.tool, "shell_batch");
    assert_eq!(archive.arguments["commands"][0], "rg TODO");
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reduces_the_recent_window_when_it_cannot_fit_the_budget() {
    let provider = MockProvider::new(vec![vec![ChatDelta::Text("summary".into())]]);
    let mut messages = Vec::new();
    for index in 0..10 {
        messages.push(ChatMessage::user(format!(
            "user-{index}-{}",
            "u".repeat(600)
        )));
        messages.push(ChatMessage::assistant(format!(
            "assistant-{index}-{}",
            "a".repeat(600)
        )));
    }
    let policy = ContextPolicy {
        auto_limit: false,
        soft_limit_tokens: 800,
        preserve_recent_messages: 16,
        prune_tool_results_over_tokens: 100,
        summary_batch_tokens: 10_000,
    };
    let (events, _receiver) = tokio::sync::mpsc::channel(4);

    let outcome = compact_history(
        &provider,
        messages,
        &[],
        &policy,
        4,
        &events,
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    assert!(outcome.compacted);
    assert!(outcome.estimated_tokens_after <= policy.soft_limit_tokens);
    assert!(outcome
        .messages
        .last()
        .unwrap()
        .content
        .contains("assistant-9"));
}
