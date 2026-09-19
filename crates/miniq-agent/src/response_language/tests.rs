use super::*;
use crate::{compact_history, run_turn, ContextPolicy, NoTools};
use miniq_models::{mock::MockProvider, ChatDelta, ProviderContext, ToolCallRequest};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[test]
fn language_policy_preserves_user_text_and_native_replay_without_promoting_them() {
    let mut assistant = ChatMessage::assistant("Earlier English reply");
    assistant.provider_context = Some(ProviderContext {
        protocol: miniq_models::ApiProtocol::AnthropicMessages,
        data: json!([{"type":"text","text":"Earlier English reply"}]),
    });
    let user = "帮我用英文写邮件，再用中文解释。保留 `CustomerId` 和 /work/report.md。";
    for system in [None, Some(ChatMessage::system("Host instructions"))] {
        let mut history = system.into_iter().collect::<Vec<_>>();
        history.extend([assistant.clone(), ChatMessage::user(user)]);
        let original = serde_json::to_value(&history).unwrap();
        let request = request_messages(&history, ModelCallPurpose::Task);

        assert_eq!(serde_json::to_value(&history).unwrap(), original);
        assert_eq!(request[0].role, ChatRole::System);
        assert!(request[0].content.contains(RESPONSE_LANGUAGE_POLICY));
        assert!(!request[0].content.contains(user));
        assert_eq!(request.last().unwrap().content, user);
        assert_eq!(
            crate::estimate_tokens(&request),
            crate::estimate_tokens(&history) + token_overhead(&history, ModelCallPurpose::Task)
        );
        assert_eq!(
            request[request.len() - 2].provider_context,
            assistant.provider_context
        );
    }
}

#[tokio::test(start_paused = true)]
async fn language_policy_survives_tools_retries_and_followups_without_history_growth() {
    let provider = MockProvider::new(vec![
        vec![ChatDelta::ToolCall(ToolCallRequest {
            id: "lookup".into(),
            name: "lookup".into(),
            arguments: json!({}),
        })],
        vec![],
        vec![ChatDelta::Text("已完成。".into())],
        vec![ChatDelta::Text("Done.".into())],
    ]);
    let user = "请检查结果，给我中文说明。";
    let history = vec![
        ChatMessage::system("English host instructions"),
        ChatMessage::assistant("An earlier English response"),
        ChatMessage::user(user),
    ];
    let (events, _) = tokio::sync::mpsc::channel(32);
    let outcome = run_turn(
        &provider,
        &NoTools,
        history,
        events,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.final_text, "已完成。");
    assert!(!serde_json::to_string(&outcome.provider_history)
        .unwrap()
        .contains("Response language:"));

    let mut continued = outcome.provider_history;
    continued.push(ChatMessage::user("Now explain it in English."));
    let (events, _) = tokio::sync::mpsc::channel(16);
    run_turn(
        &provider,
        &NoTools,
        continued,
        events,
        CancellationToken::new(),
    )
    .await
    .unwrap();

    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    for request in requests.iter() {
        assert_eq!(
            request.messages[0]
                .content
                .matches(RESPONSE_LANGUAGE_POLICY)
                .count(),
            1
        );
    }
    assert_eq!(requests[1].messages.last().unwrap().role, ChatRole::Tool);
    assert_eq!(requests[1].messages[2].content, user);
    assert_eq!(
        requests[3].messages.last().unwrap().content,
        "Now explain it in English."
    );
}

#[tokio::test]
async fn compaction_keeps_scoped_language_requirements_as_context_not_new_instructions() {
    let user = "请用英文写邮件，并用中文解释修改。";
    let provider = MockProvider::text(
        "User communication language: Chinese. Deliverable: English email; explanation: Chinese.",
    );
    let history = vec![
        ChatMessage::system("English host instructions"),
        ChatMessage::user(user),
        ChatMessage::assistant("Earlier English response"),
        ChatMessage::user("继续"),
        ChatMessage::assistant("Working"),
    ];
    let (events, _) = tokio::sync::mpsc::channel(8);
    let compacted = compact_history(
        &provider,
        history,
        &[],
        &ContextPolicy {
            soft_limit_tokens: 8,
            preserve_recent_messages: 2,
            prune_tool_results_over_tokens: 2,
            summary_batch_tokens: 100,
        },
        1,
        &events,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests[0].trace.purpose, ModelCallPurpose::Compaction);
    assert!(requests[0].messages[0]
        .content
        .contains("output languages with their scope"));
    assert!(requests[0].messages[1].content.contains(user));

    let next = request_messages(&compacted.messages, ModelCallPurpose::Task);
    assert!(next[0].content.contains(RESPONSE_LANGUAGE_POLICY));
    assert!(next[1].content.contains("explanation: Chinese"));
    assert_eq!(next[2].content, "继续");
}

#[test]
fn internal_review_requests_keep_their_existing_contract() {
    let history = vec![
        ChatMessage::system("Internal review instructions"),
        ChatMessage::user("Reconcile the completed plan"),
    ];
    for purpose in [
        ModelCallPurpose::PlanReview,
        ModelCallPurpose::SkillLearning,
        ModelCallPurpose::Compaction,
    ] {
        assert_eq!(token_overhead(&history, purpose), 0);
        assert_eq!(
            serde_json::to_value(request_messages(&history, purpose)).unwrap(),
            serde_json::to_value(&history).unwrap()
        );
    }
}
