//! Wire serialization for model-routing gateways.

use serde::{ser::SerializeMap, Serialize, Serializer};
use serde_json::Value;

/// Serialize the root `model` field before potentially large input or media.
///
/// JSON objects are unordered, but some gateways inspect only a request prefix
/// to select a model/channel. `Value` otherwise sorts keys, which can place an
/// entire multimodal history before `model`. Use this at the HTTP JSON boundary;
/// converting it back to `Value` first would lose the wire ordering again.
/// All field values (including signed provider context) are preserved unchanged.
pub struct ModelFirstRequest<'a>(pub &'a Value);

impl Serialize for ModelFirstRequest<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Some(object) = self.0.as_object() else {
            return self.0.serialize(serializer);
        };
        let mut map = serializer.serialize_map(Some(object.len()))?;
        if let Some(model) = object.get("model") {
            map.serialize_entry("model", model)?;
        }
        for (key, value) in object {
            if key != "model" {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_precedes_large_input_without_changing_any_content() {
        let body = json!({
            "model": "gpt-测试\"\\",
            "input": [
                {"type":"reasoning", "encrypted_content":"opaque+/==\n签名"},
                {"role":"user", "content":[
                    {"type":"input_text", "text":"完整视觉信息，不能截断。".repeat(10_000)},
                    {"type":"input_image", "image_url":format!("data:image/png;base64,{}", "A".repeat(1_000_000))}
                ]},
                {"type":"function_call", "call_id":"call-1", "name":"read", "arguments":"{\"model\":\"nested\"}"},
                {"type":"function_call_output", "call_id":"call-1", "output":"\"原样\"\n"}
            ],
            "max_output_tokens": 4096,
            "tools": [{"type":"function", "parameters":{"type":"object", "properties":{"model":{"type":"string"}}}}],
            "stream": true
        });
        let ordinary = serde_json::to_vec(&body).unwrap();
        let bytes = serde_json::to_vec(&ModelFirstRequest(&body)).unwrap();
        assert!(bytes.starts_with(b"{\"model\":"));
        assert_eq!(bytes.len(), ordinary.len());
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), body);
        assert_eq!(serde_json::to_vec(&body).unwrap(), ordinary);
    }

    #[test]
    fn absent_model_and_non_object_values_are_not_modified() {
        for body in [
            json!({"input":"no model"}),
            json!({}),
            json!([1, "二"]),
            Value::Null,
        ] {
            assert_eq!(
                serde_json::to_vec(&ModelFirstRequest(&body)).unwrap(),
                serde_json::to_vec(&body).unwrap()
            );
        }
    }
}
