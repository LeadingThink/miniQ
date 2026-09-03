//! Daemon side of skill learning: transcript assembly from the store and a
//! SkillInference implementation over the configured model provider.

use futures_util::StreamExt;
use miniq_models::{ChatDelta, ChatMessage, CompletionRequest, ModelProvider};
use miniq_protocol::Role;
use miniq_skills::SkillInference;

use crate::state::AppState;

/// Cap per-item content in the distillation prompt. This only affects the
/// prompt sent to the model; persisted data stays complete.
const MAX_ITEM_CHARS: usize = 1500;

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_ITEM_CHARS {
        return text.to_string();
    }
    let clipped: String = text.chars().take(MAX_ITEM_CHARS).collect();
    format!("{clipped}\n...(truncated for distillation)")
}

/// Assemble a readable transcript of one session: messages and tool calls
/// interleaved chronologically.
pub fn build_transcript(state: &AppState, session_id: &str) -> Result<String, String> {
    let messages = state
        .store
        .list_messages(session_id)
        .map_err(|e| e.to_string())?;
    let tool_calls = state
        .store
        .list_tool_calls(session_id)
        .map_err(|e| e.to_string())?;

    enum Item {
        Message(miniq_protocol::Message),
        ToolCall(miniq_protocol::ToolCall),
    }
    let mut items: Vec<(String, Item)> = messages
        .into_iter()
        .map(|m| (m.created_at.clone(), Item::Message(m)))
        .chain(
            tool_calls
                .into_iter()
                .map(|t| (t.created_at.clone(), Item::ToolCall(t))),
        )
        .collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = String::new();
    for (_, item) in items {
        match item {
            Item::Message(m) => {
                out.push_str(&format!("[{}] {}\n\n", m.role.as_str(), clip(&m.content)));
            }
            Item::ToolCall(t) => {
                out.push_str(&format!(
                    "[tool_call {} -> {}] input: {}\n",
                    t.tool_name,
                    t.status.as_str(),
                    clip(&t.input.to_string()),
                ));
                if let Some(output) = &t.output {
                    out.push_str(&format!("[tool_result] {}\n\n", clip(&output.to_string())));
                }
            }
        }
    }
    if out.trim().is_empty() {
        return Err("session has no content to distill".to_string());
    }
    Ok(out)
}

/// Whether a session looks distillable at all (has at least one user message
/// and one completed assistant reply).
pub fn has_completed_turn(state: &AppState, session_id: &str) -> bool {
    state
        .store
        .list_messages(session_id)
        .map(|messages| {
            messages.iter().any(|m| m.role == Role::User)
                && messages.iter().any(|m| m.role == Role::Assistant)
        })
        .unwrap_or(false)
}

/// SkillInference over the session's model provider (non-streaming collect).
pub struct ProviderInference {
    pub provider: std::sync::Arc<dyn ModelProvider>,
}

#[async_trait::async_trait]
impl SkillInference for ProviderInference {
    async fn complete(&self, system: &str, user: &str) -> Result<String, String> {
        let request = CompletionRequest {
            messages: vec![ChatMessage::system(system), ChatMessage::user(user)],
            tools: Vec::new(),
            // Keep auxiliary inference compatible with thinking models whose
            // gateways reject custom temperatures.
            temperature: None,
        };
        let mut stream = self
            .provider
            .stream_complete(request)
            .await
            .map_err(|e| e.to_string())?;
        let mut text = String::new();
        while let Some(delta) = stream.next().await {
            match delta.map_err(|e| e.to_string())? {
                ChatDelta::Reasoning(_) => {}
                ChatDelta::Text(t) => text.push_str(&t),
                ChatDelta::ToolCall(_) => {}
                ChatDelta::Finished => break,
            }
        }
        Ok(text)
    }
}
