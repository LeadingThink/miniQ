use futures_util::StreamExt;
use miniq_models::{ChatDelta, ChatMessage, ChatRole, CompletionRequest, ModelProvider};
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
            soft_limit_tokens: 96_000,
            preserve_recent_messages: 24,
            prune_tool_results_over_tokens: 4_000,
            summary_batch_tokens: 48_000,
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
    ascii.div_ceil(4) + non_ascii
}

fn prune_old_tool_results(messages: &mut [ChatMessage], policy: &ContextPolicy) -> bool {
    let recent_start = messages
        .len()
        .saturating_sub(policy.preserve_recent_messages);
    let mut changed = false;
    for message in &mut messages[..recent_start] {
        if message.role == ChatRole::Tool
            && estimate_text_tokens(&message.content) > policy.prune_tool_results_over_tokens
        {
            let original_tokens = estimate_text_tokens(&message.content);
            message.content = serde_json::json!({
                "compacted": true,
                "reason": "old_tool_result",
                "originalEstimatedTokens": original_tokens,
            })
            .to_string();
            changed = true;
        }
    }
    changed
}

fn recent_boundary(messages: &[ChatMessage], preserve: usize) -> usize {
    if messages.is_empty() {
        return 0;
    }
    let desired = messages
        .len()
        .saturating_sub(preserve)
        .min(messages.len() - 1);
    (0..=desired)
        .rev()
        .find(|index| messages[*index].role == ChatRole::User)
        .unwrap_or(0)
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
    policy: &ContextPolicy,
    events: &tokio::sync::mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> Result<ContextOutcome, AgentError> {
    let estimated_tokens_before = estimate_tokens(&messages);
    if estimated_tokens_before <= policy.soft_limit_tokens {
        return Ok(ContextOutcome {
            messages,
            compacted: false,
            estimated_tokens_before,
            estimated_tokens_after: estimated_tokens_before,
        });
    }

    let pruned = prune_old_tool_results(&mut messages, policy);
    if estimate_tokens(&messages) <= policy.soft_limit_tokens {
        let estimated_tokens_after = estimate_tokens(&messages);
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
    let boundary =
        recent_boundary(&messages, policy.preserve_recent_messages).max(conversation_start);
    let old = &messages[conversation_start..boundary];
    if old.is_empty() {
        let estimated_tokens_after = estimate_tokens(&messages);
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
    let estimated_tokens_after = estimate_tokens(&compacted_messages);
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
}
