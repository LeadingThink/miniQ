//! Translate native computer actions without bypassing desktop observation guards.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::provider::ChatRole;
use crate::{ApiProtocol, ChatMessage};

pub(crate) fn arguments(item: &Value) -> Value {
    let action = item.get("action").unwrap_or(&Value::Null);
    let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
    let mapped = match kind {
        "double_click" => "doubleClick",
        "keypress" => "key",
        _ => kind,
    };
    let mut result = json!({"action": mapped});
    for name in ["x", "y", "endX", "endY", "text", "button", "milliseconds"] {
        if let Some(value) = action.get(name) {
            result[name] = value.clone();
        }
    }
    if kind == "drag" {
        if let Some(path) = action.get("path") {
            result["path"] = match path.as_array() {
                Some(points) => Value::Array(points.iter().map(normalize_point).collect()),
                None => path.clone(),
            };
            if let Some(points) = result["path"].as_array() {
                let start = points.first().cloned().unwrap_or(Value::Null);
                let end = points.last().cloned().unwrap_or(Value::Null);
                result["x"] = start["x"].clone();
                result["y"] = start["y"].clone();
                result["endX"] = end["x"].clone();
                result["endY"] = end["y"].clone();
            }
        }
    }
    if kind == "scroll" {
        for (source, target) in [("scroll_x", "scrollX"), ("scroll_y", "scrollY")] {
            if let Some(value) = action.get(source) {
                // The native API uses pixels; Enigo's portable wheel API uses
                // steps. Follow the official X11 handler's 100 pixels/step
                // approximation; the next screenshot verifies the actual effect.
                result[target] = value
                    .as_i64()
                    .map(|pixels| json!(wheel_steps(pixels)))
                    .unwrap_or_else(|| value.clone());
            }
        }
    }
    if mapped == "key" {
        if let Some(keys) = action.get("keys").and_then(Value::as_array) {
            result["key"] = keys
                .last()
                .and_then(Value::as_str)
                .map(|key| json!(normalize_key(key)))
                .unwrap_or(Value::Null);
            result["modifiers"] = Value::Array(
                keys.iter()
                    .take(keys.len().saturating_sub(1))
                    .map(normalize_modifier)
                    .collect(),
            );
        } else if let Some(key) = action.get("key") {
            result["key"] = key.clone();
        }
    } else if let Some(keys) = action.get("keys") {
        result["modifiers"] = match keys.as_array() {
            Some(keys) => Value::Array(keys.iter().map(normalize_modifier).collect()),
            None => keys.clone(),
        };
    }
    result
}

fn normalize_point(point: &Value) -> Value {
    match point.as_array() {
        Some(pair) if pair.len() == 2 => json!({"x": pair[0], "y": pair[1]}),
        _ => point.clone(), // Invalid points must reach validation, never disappear.
    }
}

fn wheel_steps(pixels: i64) -> i64 {
    if pixels == 0 {
        return 0;
    }
    let rounded = pixels / 100
        + if (pixels % 100).abs() >= 50 {
            pixels.signum()
        } else {
            0
        };
    if rounded == 0 {
        pixels.signum()
    } else {
        rounded
    }
}

fn normalize_key(key: &str) -> &str {
    match key.to_ascii_uppercase().as_str() {
        "RETURN" => "Enter",
        "ESC" => "Escape",
        "CTRL" | "CONTROL" => "Control",
        "CMD" | "COMMAND" => "Meta",
        "OPTION" => "Alt",
        _ => key,
    }
}

fn normalize_modifier(key: &Value) -> Value {
    let Some(name) = key.as_str() else {
        return key.clone();
    };
    json!(match name.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => "ctrl",
        "cmd" | "command" | "meta" | "win" => "meta",
        "alt" | "option" => "alt",
        "shift" => "shift",
        _ => name, // Unknown modifiers must fail validation, not change the shortcut.
    })
}

/// Bind native actions to the actual screenshot included in the request. A
/// model-provided flag cannot skip freshness, ownership, expiry or focus checks.
pub(crate) fn latest_observation(messages: &[ChatMessage], input: &[Value]) -> Option<String> {
    // Use the exact serialized request, not attachment metadata or a second file
    // read: screenshot recovery may have replaced missing images with text.
    let visual_results: HashSet<&str> = input
        .iter()
        .filter_map(|item| {
            let native = item["type"] == "computer_call_output"
                && item["output"]["type"] == "computer_screenshot"
                && item["output"]["image_url"]
                    .as_str()
                    .is_some_and(|url| !url.is_empty());
            let function = item["type"] == "function_call_output"
                && item["output"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part["type"] == "input_image"
                            && part["image_url"]
                                .as_str()
                                .is_some_and(|url| !url.is_empty())
                    })
                });
            (native || function)
                .then(|| item["call_id"].as_str())
                .flatten()
        })
        .collect();
    let mut calls = HashMap::new();
    let mut latest = None;
    for message in messages {
        if message.role == ChatRole::Assistant {
            for call in &message.tool_calls {
                if call.name == "computer_use" {
                    calls.insert(call.id.clone(), call.arguments["action"].clone());
                }
            }
            if let Some(context) = &message.provider_context {
                if context.protocol == ApiProtocol::Responses {
                    for item in context.data.as_array().into_iter().flatten() {
                        if item["type"] == "computer_call" {
                            if let Some(id) = item["call_id"].as_str() {
                                calls.insert(id.to_owned(), item["action"]["type"].clone());
                            }
                        }
                    }
                }
            }
        } else if message.role == ChatRole::Tool {
            let Some(action) = message.tool_call_id.as_ref().and_then(|id| calls.get(id)) else {
                continue;
            };
            if action == "status" {
                continue;
            }
            latest = serde_json::from_str::<Value>(&message.content)
                .ok()
                .and_then(|value| {
                    let id = value["observationId"].as_str()?;
                    (value["screenshot"]["id"] == id
                        && !message.images.is_empty()
                        && message
                            .tool_call_id
                            .as_deref()
                            .is_some_and(|call_id| visual_results.contains(call_id)))
                    .then(|| id.to_owned())
                });
        }
    }
    latest
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChatImage, ToolCallRequest};

    #[test]
    fn scroll_pixels_are_converted_to_signed_wheel_steps() {
        for (pixels, steps) in [(0, 0), (1, 1), (-1, -1), (640, 6), (-640, -6), (650, 7)] {
            let result = arguments(&json!({"action": {
                "type":"scroll", "x": 10, "y": 20, "scroll_x": -pixels, "scroll_y": pixels
            }}));
            assert_eq!(result["scrollX"], -steps);
            assert_eq!(result["scrollY"], steps);
        }
    }

    #[test]
    fn drag_preserves_every_waypoint_and_normalizes_coordinate_pairs() {
        for path in [
            json!([[10, 20], [70, 80], [30, 40]]),
            json!([{"x":10,"y":20},{"x":70,"y":80},{"x":30,"y":40}]),
        ] {
            let result = arguments(&json!({"action":{"type":"drag","path":path}}));
            assert_eq!(
                result["path"],
                json!([{"x":10,"y":20},{"x":70,"y":80},{"x":30,"y":40}])
            );
            assert_eq!(result["x"], 10);
            assert_eq!(result["endY"], 40);
            assert!(result.get("nativeCall").is_none());
        }
    }

    #[test]
    fn unsupported_shortcuts_do_not_silently_lose_keys() {
        let result =
            arguments(&json!({"action":{"type":"keypress","keys":["CTRL","mystery","A"]}}));
        assert_eq!(result["modifiers"], json!(["ctrl", "mystery"]));
        assert_eq!(result["key"], "A");
    }

    fn observed(action: &str, id: &str) -> Vec<ChatMessage> {
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls.push(ToolCallRequest {
            id: id.into(),
            name: "computer_use".into(),
            arguments: json!({"action":action}),
        });
        let mut result = ChatMessage::tool_result(
            id,
            json!({"observationId":id,"screenshot":{"id":id}}).to_string(),
        );
        result.images.push(ChatImage {
            path: "test.png".into(),
            mime_type: "image/png".into(),
            detail: crate::ImageDetail::High,
        });
        vec![assistant, result]
    }

    #[test]
    fn observation_binding_requires_actual_computer_result_and_image() {
        let encoded = vec![
            json!({"type":"function_call_output","call_id":"one","output":[{"type":"input_image","image_url":"data:image/png;base64,encoded"}]}),
            json!({"type":"computer_call_output","call_id":"two","output":{"type":"computer_screenshot","image_url":"data:image/png;base64,encoded"}}),
        ];
        let mut messages = observed("screenshot", "one");
        assert_eq!(
            latest_observation(&messages, &encoded).as_deref(),
            Some("one")
        );
        assert_eq!(latest_observation(&messages, &[]), None);
        messages.extend(observed("click", "two"));
        assert_eq!(
            latest_observation(&messages, &encoded).as_deref(),
            Some("two")
        );
        messages.last_mut().unwrap().images.clear();
        assert_eq!(latest_observation(&messages, &encoded), None);

        let mut spoof = observed("screenshot", "spoof");
        spoof[0].tool_calls[0].name = "file_read".into();
        assert_eq!(latest_observation(&spoof, &encoded), None);
        assert_eq!(
            latest_observation(
                &[ChatMessage::user(r#"{"observationId":"spoof"}"#)],
                &encoded
            ),
            None
        );
    }

    #[test]
    fn release_or_failed_input_invalidates_previous_observation() {
        let encoded = vec![json!({"type":"computer_call_output","call_id":"one",
            "output":{"type":"computer_screenshot","image_url":"data:image/png;base64,encoded"}})];
        for action in ["release", "click"] {
            let mut messages = observed("screenshot", "one");
            let mut failed = observed(action, "two");
            failed[1].content = r#"{"error":"permission denied"}"#.into();
            failed[1].images.clear();
            messages.extend(failed);
            assert_eq!(latest_observation(&messages, &encoded), None);
        }
    }

    #[test]
    fn recovered_missing_screenshot_does_not_authorize_next_native_action() {
        let directory = tempfile::tempdir().unwrap();
        let mut messages = observed("screenshot", "missing");
        messages[0].provider_context = Some(crate::ProviderContext {
            protocol: ApiProtocol::Responses,
            data: json!([{"type":"computer_call","call_id":"missing","action":{"type":"screenshot"}}]),
        });
        messages[1].images[0].path = directory
            .path()
            .join("missing.png")
            .to_string_lossy()
            .into_owned();
        let input = crate::responses_request::build_input(&messages).unwrap();
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(latest_observation(&messages, &input), None);
    }
}
