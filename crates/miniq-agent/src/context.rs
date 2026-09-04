use futures_util::StreamExt;
use miniq_models::{ChatDelta, ChatMessage, ChatRole, CompletionRequest, ModelProvider, ToolSpec};
use tokio_util::sync::CancellationToken;

use crate::{AgentError, AgentEvent};

#[derive(Debug, Clone)]
pub struct ContextPolicy {
    pub soft_limit_tokens: usize,
    pub preserve_recent_messages: usize,
    pub prune_tool_results_over_tokens: usize,
    pub summary_batch_tokens: usize,
}

impl Default for ContextPolicy {
    fn default() -> Self {
        Self {
            soft_limit_tokens: 64_000,
            preserve_recent_messages: 16,
            prune_tool_results_over_tokens: 2_000,
            summary_batch_tokens: 32_000,
        }
    }
}

pub struct ContextOutcome {
    pub messages: Vec<ChatMessage>,
    pub compacted: bool,
    pub estimated_tokens_before: usize,
    pub estimated_tokens_after: usize,
}

pub fn estimate_tokens(messages: &[ChatMessage]) -> usize {
    messages
        .iter()
        .map(|message| {
            let provider_tokens = message
                .provider_context
                .as_ref()
                .map(|context| estimate_text_tokens(&context.data.to_string()));
            provider_tokens.unwrap_or_else(|| {
                estimate_text_tokens(&message.content)
                    + message
                        .tool_calls
                        .iter()
                        .map(|call| {
                            estimate_text_tokens(&call.name)
                                + estimate_text_tokens(&call.arguments.to_string())
                                + 8
                        })
                        .sum::<usize>()
            }) + message.images.len() * 1_024
                + 6
        })
        .sum()
}

fn estimate_text_tokens(value: &str) -> usize {
    let mut ascii: usize = 0;
    let mut non_ascii: usize = 0;
    for character in value.chars() {
        if character.is_ascii() {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }
    // Source code, JSON, paths, and shell output commonly tokenize closer to
    // three ASCII characters per token than prose's often-quoted four.
    ascii.div_ceil(3) + non_ascii
}

pub fn estimate_request_tokens(messages: &[ChatMessage], tools: &[ToolSpec]) -> usize {
    let tool_tokens = serde_json::to_string(tools)
        .ok()
        .map(|tools| estimate_text_tokens(&tools))
        .unwrap_or_default();
    estimate_tokens(messages) + tool_tokens + 32
}

fn prune_tool_results_to_limit(
    messages: &mut [ChatMessage],
    tools: &[ToolSpec],
    policy: &ContextPolicy,
) -> bool {
    let mut changed = false;
    let mut request_tokens = estimate_request_tokens(messages, tools);
    for message in messages.iter_mut() {
        if request_tokens <= policy.soft_limit_tokens {
            break;
        }
        if message.role != ChatRole::Tool {
            continue;
        }
        let original_tokens = estimate_text_tokens(&message.content);
        if original_tokens <= policy.prune_tool_results_over_tokens {
            continue;
        }
        let previous_message_tokens = estimate_tokens(std::slice::from_ref(message));
        message.content = serde_json::json!({
            "compacted": true,
            "reason": "oversized_tool_result",
            "originalEstimatedTokens": original_tokens
        })
        .to_string();
        let compacted_message_tokens = estimate_tokens(std::slice::from_ref(message));
        request_tokens = request_tokens
            .saturating_sub(previous_message_tokens)
            .saturating_add(compacted_message_tokens);
        changed = true;
    }
    changed
}

fn is_safe_start(message: &ChatMessage) -> bool {
    message.role == ChatRole::User
        || (message.role == ChatRole::Assistant && !message.tool_calls.is_empty())
}

fn recent_boundary(messages: &[ChatMessage], preserve: usize) -> usize {
    if messages.is_empty() {
        return 0;
    }
    let desired = messages
        .len()
        .saturating_sub(preserve)
        .min(messages.len() - 1);
    (desired..messages.len())
        .find(|index| is_safe_start(&messages[*index]))
        .or_else(|| {
            (1..desired)
                .rev()
                .find(|index| is_safe_start(&messages[*index]))
        })
        .unwrap_or(0)
}

fn summary_boundary(
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    policy: &ContextPolicy,
    conversation_start: usize,
) -> usize {
    let preferred =
        recent_boundary(messages, policy.preserve_recent_messages).max(conversation_start);
    let recent_target = policy.soft_limit_tokens.saturating_mul(3) / 4;
    if preferred > conversation_start
        && estimate_request_tokens(&messages[preferred..], tools) <= recent_target
    {
        return preferred;
    }

    // A short conversation can still be oversized when a single turn emits
    // several large results. Keep a valid user/tool boundary, but allow more
    // than the preferred recent-message count to be summarized when required.
    (preferred.max(conversation_start + 1)..messages.len())
        .filter(|index| is_safe_start(&messages[*index]))
        .find(|index| estimate_request_tokens(&messages[*index..], tools) <= recent_target)
        .or_else(|| {
            (conversation_start + 1..messages.len())
                .rev()
                .find(|index| is_safe_start(&messages[*index]))
        })
        .unwrap_or(conversation_start)
}

fn batches(messages: &[ChatMessage], limit: usize) -> Vec<Vec<ChatMessage>> {
    let mut result = Vec::new();
    let mut current = Vec::new();
    let mut current_tokens = 0;
    for message in messages {
        let message_tokens = estimate_tokens(std::slice::from_ref(message));
        if !current.is_empty() && current_tokens + message_tokens > limit {
            result.push(std::mem::take(&mut current));
            current_tokens = 0;
        }
        current.push(message.clone());
        current_tokens += message_tokens;
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

async fn summarize_batch(
    provider: &dyn ModelProvider,
    messages: &[ChatMessage],
    cancel: &CancellationToken,
) -> Result<String, AgentError> {
    let transcript = serde_json::to_string(messages).map_err(|error| {
        AgentError::Provider(miniq_models::ProviderError::InvalidResponse(
            error.to_string(),
        ))
    })?;
    let request = CompletionRequest {
        messages: vec![
            ChatMessage::system(
                "Compress the conversation into a precise working-memory handoff. Preserve user goals, decisions, constraints, file paths, commands, errors, completed work, pending work, and facts needed to continue. Omit pleasantries and repeated tool output. Do not invent anything.",
            ),
            ChatMessage::user(transcript),
        ],
        tools: Vec::new(),
        // Provider defaults are the only portable choice here: thinking
        // models may reject any explicit value other than 1.
        temperature: None,
        max_output_tokens: Some(8_192),
    };
    let mut stream = tokio::select! {
        _ = cancel.cancelled() => return Err(AgentError::Cancelled),
        stream = provider.stream_complete(request) => stream?,
    };
    let mut summary = String::new();
    loop {
        let delta = tokio::select! {
            _ = cancel.cancelled() => return Err(AgentError::Cancelled),
            delta = stream.next() => delta,
        };
        let Some(delta) = delta else { break };
        match delta? {
            ChatDelta::Text(text) => summary.push_str(&text),
            ChatDelta::ToolCall(_) => {
                return Err(AgentError::Provider(
                    miniq_models::ProviderError::InvalidResponse(
                        "context compaction attempted a tool call".to_string(),
                    ),
                ));
            }
            ChatDelta::Context(_) => {}
            ChatDelta::Finished => break,
        }
    }
    if summary.trim().is_empty() {
        return Err(AgentError::Provider(
            miniq_models::ProviderError::InvalidResponse(
                "context compaction returned an empty summary".to_string(),
            ),
        ));
    }
    Ok(summary)
}

pub async fn compact_history(
    provider: &dyn ModelProvider,
    mut messages: Vec<ChatMessage>,
    tools: &[ToolSpec],
    policy: &ContextPolicy,
    events: &tokio::sync::mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> Result<ContextOutcome, AgentError> {
    let estimated_tokens_before = estimate_request_tokens(&messages, tools);
    if estimated_tokens_before <= policy.soft_limit_tokens {
        return Ok(ContextOutcome {
            messages,
            compacted: false,
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }

    // Context limits are absolute: one multi-megabyte result must be compacted
    // even when it is part of the newest tool batch.
    let pruned = prune_tool_results_to_limit(&mut messages, tools, policy);
    if estimate_request_tokens(&messages, tools) <= policy.soft_limit_tokens {
        let estimated_tokens_after = estimate_request_tokens(&messages, tools);
        let _ = events
            .send(AgentEvent::ContextCompacted {
                estimated_tokens_before,
                estimated_tokens_after,
            })
            .await;
        return Ok(ContextOutcome {
            messages,
            compacted: pruned,
            estimated_tokens_before,
            estimated_tokens_after,
        });
    }

    let system = messages
        .first()
        .filter(|message| message.role == ChatRole::System)
        .cloned();
    let conversation_start = usize::from(system.is_some());
    let boundary = summary_boundary(&messages, tools, policy, conversation_start);
    let old = &messages[conversation_start..boundary];
    if old.is_empty() {
        let estimated_tokens_after = estimate_request_tokens(&messages, tools);
        return Ok(ContextOutcome {
            messages,
            compacted: pruned,
            estimated_tokens_before,
            estimated_tokens_after,
        });
    }

    let mut summaries = Vec::new();
    for batch in batches(old, policy.summary_batch_tokens) {
        summaries.push(summarize_batch(provider, &batch, cancel).await?);
    }
    while estimate_text_tokens(&summaries.join("\n\n")) > policy.summary_batch_tokens
        && summaries.len() > 1
    {
        let summary_messages = summaries
            .drain(..)
            .map(ChatMessage::user)
            .collect::<Vec<_>>();
        summaries = vec![summarize_batch(provider, &summary_messages, cancel).await?];
    }

    let mut compacted_messages = Vec::new();
    if let Some(system) = system {
        compacted_messages.push(system);
    }
    compacted_messages.push(ChatMessage::system(format!(
        "Compacted conversation context (authoritative working summary):\n{}",
        summaries.join("\n\n")
    )));
    compacted_messages.extend_from_slice(&messages[boundary..]);
    let estimated_tokens_after = estimate_request_tokens(&compacted_messages, tools);
    let _ = events
        .send(AgentEvent::ContextCompacted {
            estimated_tokens_before,
            estimated_tokens_after,
        })
        .await;
    Ok(ContextOutcome {
        messages: compacted_messages,
        compacted: true,
        estimated_tokens_before,
        estimated_tokens_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_models::mock::MockProvider;

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
    async fn compacts_an_oversized_tool_result_inside_the_recent_window() {
        let provider = MockProvider::new(Vec::new());
        let messages = vec![
            ChatMessage::system("system"),
            ChatMessage::user("inspect"),
            ChatMessage::assistant("running command"),
            ChatMessage::tool_result("call-1", "x".repeat(3_200_000)),
        ];
        let policy = ContextPolicy {
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
}
