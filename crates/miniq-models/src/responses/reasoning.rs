use std::collections::BTreeMap;

use serde_json::{json, Value};

/// Plaintext reasoning is streamed separately from the final output item by
/// some Responses gateways. Preserve it across the provider-history boundary.
#[derive(Default)]
pub(super) struct ReasoningText {
    parts: BTreeMap<(usize, usize), String>,
}

impl ReasoningText {
    pub(super) fn capture(&mut self, event: &Value) {
        let output = event["output_index"].as_u64().unwrap_or(0) as usize;
        let content = event["content_index"].as_u64().unwrap_or(0) as usize;
        let part = self.parts.entry((output, content)).or_default();
        if let Some(delta) = event["delta"].as_str() {
            part.push_str(delta);
        } else if let Some(text) = event["text"].as_str() {
            // A done event carries the whole part, including preceding deltas.
            *part = text.to_owned();
        }
    }

    pub(super) fn restore(&self, items: &mut BTreeMap<usize, Value>) {
        let mut texts: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
        for ((output, _), text) in &self.parts {
            texts.entry(*output).or_default().push(text);
        }
        for (index, parts) in texts {
            let item = items
                .entry(index)
                .or_insert_with(|| json!({"type":"reasoning"}));
            if item["type"] != "reasoning" {
                continue;
            }
            let has_content = match &item["content"] {
                Value::String(text) => !text.is_empty(),
                Value::Array(parts) => parts
                    .iter()
                    .any(|part| part["text"].as_str().is_some_and(|text| !text.is_empty())),
                _ => false,
            };
            if !has_content {
                item["content"] = json!(parts.join("\n"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_parts_in_order_without_duplicating_done_text_or_replacing_native_content() {
        let mut reasoning = ReasoningText::default();
        for event in [
            json!({"output_index":0,"content_index":0,"delta":"First"}),
            json!({"output_index":0,"content_index":0,"text":"First part"}),
            json!({"output_index":0,"content_index":1,"text":"Second part"}),
            json!({"output_index":2,"content_index":0,"text":"Streamed"}),
        ] {
            reasoning.capture(&event);
        }
        let native = json!({"type":"reasoning","content":[{"type":"reasoning_text","text":"Complete native text"}],"encrypted_content":"opaque"});
        let mut items = BTreeMap::from([(2, native.clone())]);
        reasoning.restore(&mut items);
        assert_eq!(items[&0]["content"], "First part\nSecond part");
        assert_eq!(items[&2], native);
    }
}
