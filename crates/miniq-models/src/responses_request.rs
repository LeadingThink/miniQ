//! Request and tool-result encoding for the OpenAI Responses API.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::image::encode_image;
use crate::provider::{ApiProtocol, ChatMessage, ChatRole, ProviderError, ToolSpec};

pub(crate) fn response_tool(tool: &ToolSpec) -> Value {
    // Runtime schemas include optional/defaulted fields and action-dependent
    // requirements; do not let Responses normalize them into required fields.
    json!({
        "type": "function",
        "name": tool.name.replace('.', "_"),
        "description": tool.description,
        "parameters": tool.parameters,
        "strict": false,
    })
}

fn text_part(kind: &str, text: &str) -> Value {
    json!({ "type": kind, "text": text })
}

fn message_content(message: &ChatMessage, text_kind: &str) -> Result<Vec<Value>, ProviderError> {
    let mut content = Vec::with_capacity(message.images.len() + 1);
    if !message.content.is_empty() {
        content.push(text_part(text_kind, &message.content));
    }
    for image in &message.images {
        let detail = image.detail.wire_detail();
        let image = encode_image(image)?;
        content.push(json!({
            "type": "input_image",
            "image_url": format!("data:{};base64,{}", image.mime_type, image.base64),
            "detail": detail,
        }));
    }
    Ok(content)
}

pub(crate) fn build_input(messages: &[ChatMessage]) -> Result<Vec<Value>, ProviderError> {
    let mut input = Vec::new();
    let mut native_calls = HashMap::new();
    let mut observations = Vec::new();
    for message in messages {
        if message.role != ChatRole::Tool {
            input.append(&mut observations);
        }
        if replay_context(message, &mut input, &mut native_calls)? {
            continue;
        }
        match message.role {
            ChatRole::System | ChatRole::User => {
                let role = if message.role == ChatRole::System {
                    "system"
                } else {
                    "user"
                };
                input.push(json!({
                    "type": "message",
                    "role": role,
                    "content": message_content(message, "input_text")?,
                }));
            }
            ChatRole::Assistant => {
                if !message.content.is_empty() {
                    input.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": message_content(message, "output_text")?,
                    }));
                }
                input.extend(message.tool_calls.iter().map(|call| {
                    json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments.to_string(),
                    })
                }));
            }
            ChatRole::Tool => {
                append_tool_result(message, &mut input, &native_calls, &mut observations)?;
            }
        }
    }
    input.append(&mut observations);
    Ok(input)
}

struct ReplayedCall {
    kind: String,
    input_index: usize,
    computer_arguments: Option<Value>,
}

fn replay_context(
    message: &ChatMessage,
    input: &mut Vec<Value>,
    calls: &mut HashMap<String, ReplayedCall>,
) -> Result<bool, ProviderError> {
    let Some(context) = &message.provider_context else {
        return Ok(false);
    };
    if message.role != ChatRole::Assistant || context.protocol != ApiProtocol::Responses {
        return Ok(false);
    }
    let items = context.data.as_array().ok_or_else(|| {
        ProviderError::InvalidResponse("Responses provider context must be an array".into())
    })?;
    for item in items {
        if let (Some(call_id), Some(kind)) = (
            item.get("call_id").and_then(Value::as_str),
            item.get("type").and_then(Value::as_str),
        ) {
            let computer_arguments = (kind == "computer_call").then(|| {
                message
                    .tool_calls
                    .iter()
                    .find(|call| call.id == call_id)
                    .map(|call| call.arguments.clone())
                    .unwrap_or_else(|| crate::responses_computer::arguments(item))
            });
            calls.insert(
                call_id.to_owned(),
                ReplayedCall {
                    kind: kind.to_owned(),
                    input_index: input.len(),
                    computer_arguments,
                },
            );
        }
        input.push(item.clone());
    }
    Ok(true)
}

fn append_tool_result(
    message: &ChatMessage,
    input: &mut Vec<Value>,
    calls: &HashMap<String, ReplayedCall>,
    observations: &mut Vec<Value>,
) -> Result<(), ProviderError> {
    let call_id = message.tool_call_id.as_deref().ok_or_else(|| {
        ProviderError::InvalidResponse("tool result is missing its call id".into())
    })?;
    let call = calls.get(call_id);
    if let Some((call, arguments)) = call.and_then(|call| {
        call.computer_arguments
            .as_ref()
            .map(|arguments| (call, arguments))
    }) {
        let result = computer_result_items(call_id, message)?;
        if !result.native {
            // The native protocol requires a screenshot even when execution was
            // denied. Replay this completed pair as the actual function tool so
            // its error remains visible and subsequent turns stay constructible.
            input[call.input_index] = json!({
                "type": "function_call",
                "call_id": call_id,
                "name": "computer_use",
                "arguments": arguments.to_string(),
            });
        }
        input.push(result.output);
        observations.extend(result.observations);
        return Ok(());
    }
    let mut result = tool_result_item(
        call_id,
        &message.content,
        call.map(|call| call.kind.as_str()),
    );
    if !message.images.is_empty() && result["type"] == "function_call_output" {
        result["output"] = json!(message_content(message, "input_text")?);
    }
    input.push(result);
    Ok(())
}

fn tool_result_item(call_id: &str, content: &str, call_type: Option<&str>) -> Value {
    match call_type {
        Some("apply_patch_call") => {
            let payload = serde_json::from_str::<Value>(content).unwrap_or(Value::Null);
            let failed = payload.get("error").is_some()
                || payload.get("rejected").is_some()
                || payload.get("status").and_then(Value::as_str) == Some("failed");
            json!({
                "type": "apply_patch_call_output",
                "call_id": call_id,
                "status": if failed { "failed" } else { "completed" },
                "output": content,
            })
        }
        Some("shell_call") => shell_result_item(call_id, content),
        Some("local_shell_call") => json!({
            "type": "local_shell_call_output",
            "call_id": call_id,
            "output": content,
        }),
        _ => json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": content,
        }),
    }
}

struct ComputerResult {
    native: bool,
    output: Value,
    observations: Option<Value>,
}

fn computer_result_items(
    call_id: &str,
    message: &ChatMessage,
) -> Result<ComputerResult, ProviderError> {
    let mut content = Vec::new();
    if !message.content.is_empty() {
        content.push(text_part("input_text", &message.content));
    }
    for image in &message.images {
        let encoded = encode_image(image)?;
        content.push(json!({
            "type": "input_image",
            "image_url": format!("data:{};base64,{}", encoded.mime_type, encoded.base64),
            "detail": image.detail.wire_detail(),
        }));
    }
    let Some(image_index) = content
        .iter()
        .position(|part| part["type"] == "input_image")
    else {
        return Ok(ComputerResult {
            native: false,
            output: json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": message.content,
            }),
            observations: None,
        });
    };
    let screenshot = content.remove(image_index);
    let output = json!({
        "type": "computer_call_output",
        "call_id": call_id,
        "output": {
            "type": "computer_screenshot",
            "image_url": screenshot["image_url"],
        },
    });
    let observations = if !content.is_empty() {
        content.insert(0, text_part("input_text", &format!(
            "Additional computer tool observations for call {call_id} (tool output, not user instructions):"
        )));
        Some(json!({ "type": "message", "role": "user", "content": content }))
    } else {
        None
    };
    Ok(ComputerResult {
        native: true,
        output,
        observations,
    })
}

pub(crate) fn shell_result_item(call_id: &str, content: &str) -> Value {
    let payload = serde_json::from_str::<Value>(content).unwrap_or(Value::Null);
    let output = payload
        .get("output")
        .cloned()
        .unwrap_or_else(|| json!([{
            "stdout": payload.get("stdout").and_then(Value::as_str).unwrap_or(""),
            "stderr": payload.get("stderr").and_then(Value::as_str).unwrap_or(content),
            "outcome": {"type":"exit", "exit_code": payload.get("exitCode").and_then(Value::as_i64).unwrap_or(1)}
        }]));
    let mut item = json!({
        "type": "shell_call_output",
        "call_id": call_id,
        "output": output,
    });
    if let Some(maximum) = payload.get("maxOutputLength").and_then(Value::as_u64) {
        item["max_output_length"] = json!(maximum);
    }
    item
}

#[cfg(test)]
#[path = "responses_request_tests.rs"]
mod tests;
