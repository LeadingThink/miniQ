//! Retire history covered by a successfully committed Responses compaction item.
use super::{estimate_request_tokens, ToolSpec};
use crate::{
    tool_history::{attach_tool_archive, collect_tool_archive},
    AgentEvent,
};
use miniq_models::{ApiProtocol, ChatMessage, ChatRole};

pub(crate) async fn compact_native_history(
    messages: &mut Vec<ChatMessage>,
    tools: &[ToolSpec],
    events: &tokio::sync::mpsc::Sender<AgentEvent>,
) {
    // Only the newly committed response may replace the preceding input.
    let Some((message_index, item_index)) =
        messages.iter().enumerate().rev().find_map(|(index, m)| {
            let context = m.provider_context.as_ref()?;
            if context.protocol != ApiProtocol::Responses {
                return None;
            }
            context
                .data
                .as_array()?
                .iter()
                .rposition(|i| i["type"] == "compaction")
                .map(|item| (index, item))
        })
    else {
        return;
    };
    let prefix = messages
        .iter()
        .take_while(|m| m.role == ChatRole::System)
        .count();
    // A checkpoint already contains the compacted window. Do not emit again.
    if message_index <= prefix && item_index == 0 {
        return;
    }
    let before = estimate_request_tokens(messages, tools);
    let archive = collect_tool_archive(messages);
    let visuals = crate::visual_history::VisualHistory::from_messages(messages);
    let message = &mut messages[message_index];
    let items = message
        .provider_context
        .as_mut()
        .unwrap()
        .data
        .as_array_mut()
        .unwrap();
    items.drain(..item_index);
    // Leading host policy remains stable; the encrypted item covers prior input.
    messages.drain(prefix..message_index);
    attach_tool_archive(messages, archive);
    visuals.persist(messages);
    let _ = events
        .send(AgentEvent::ContextCompacted {
            estimated_tokens_before: before,
            estimated_tokens_after: estimate_request_tokens(messages, tools),
        })
        .await;
}
