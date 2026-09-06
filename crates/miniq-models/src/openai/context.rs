use serde_json::{json, Map, Value};

use crate::{ApiProtocol, ChatDelta, ChatMessage, ChatRole, ProviderContext};

use super::StreamDelta;

#[derive(Default)]
pub(super) struct NativeContext {
    reasoning: Option<String>,
    tools: std::collections::BTreeMap<usize, (String, Option<Value>)>,
}

impl NativeContext {
    pub(super) fn accumulate(&mut self, delta: &StreamDelta) {
        if let Some(text) = &delta.reasoning_content {
            self.reasoning.get_or_insert_default().push_str(text);
        }
        for call in delta.tool_calls.iter().flatten() {
            let slot = self.tools.entry(call.index).or_default();
            if let Some(id) = &call.id {
                slot.0 = id.clone();
            }
            if let Some(extra) = &call.extra_content {
                slot.1 = Some(extra.clone());
            }
        }
    }

    pub(super) fn delta(&self) -> Option<ChatDelta> {
        let extras: Map<String, Value> = self
            .tools
            .values()
            .filter_map(|(id, extra)| {
                extra
                    .as_ref()
                    .filter(|_| !id.is_empty())
                    .map(|extra| (id.clone(), extra.clone()))
            })
            .collect();
        if self.reasoning.is_none() && extras.is_empty() {
            return None;
        }
        let mut data = json!({"tool_extras": extras});
        if let Some(reasoning) = &self.reasoning {
            data["reasoning_content"] = json!(reasoning);
        }
        Some(ChatDelta::Context(ProviderContext {
            protocol: ApiProtocol::ChatCompletions,
            data,
        }))
    }
}

pub(super) fn replay(message: &ChatMessage, wire: &mut Value) {
    if message.role != ChatRole::Assistant {
        return;
    }
    let Some(context) = &message.provider_context else {
        return;
    };
    if context.protocol != ApiProtocol::ChatCompletions {
        return;
    }
    // DeepSeek requires reasoning on previous final answers too, not only on
    // assistant messages containing function calls.
    if let Some(reasoning) = context.data.get("reasoning_content") {
        wire["reasoning_content"] = reasoning.clone();
    }
    if let Some(calls) = wire.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for call in calls {
            if let Some(extra) = call["id"]
                .as_str()
                .and_then(|id| context.data["tool_extras"].get(id))
            {
                call["extra_content"] = extra.clone();
            }
        }
    }
}
