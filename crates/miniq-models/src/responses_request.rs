//! Request and tool-result encoding for the OpenAI Responses API.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::image::encode_image;
use crate::provider::{ApiProtocol, ChatImage, ChatMessage, ChatRole, ProviderError, ToolSpec};

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
        let detail = image.detail;
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
    let mut native_calls = HashMap::<String, String>::new();
    for message in messages {
        if message.role == ChatRole::Assistant {
            if let Some(context) = &message.provider_context {
                if context.protocol == ApiProtocol::Responses {
                    let items = context.data.as_array().ok_or_else(|| {
                        ProviderError::InvalidResponse(
                            "Responses provider context must be an array".into(),
                        )
                    })?;
                    for item in items {
                        let Some(call_id) = item.get("call_id").and_then(Value::as_str) else {
                            continue;
                        };
                        if let Some(kind) = item.get("type").and_then(Value::as_str) {
                            native_calls.insert(call_id.to_string(), kind.to_string());
                        }
                    }
                    input.extend(items.iter().cloned());
                    continue;
                }
            }
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
                let call_id = message.tool_call_id.as_deref().ok_or_else(|| {
                    ProviderError::InvalidResponse("tool result is missing its call id".into())
                })?;
                let mut result = tool_result_item(
                    call_id,
                    &message.content,
                    native_calls.get(call_id).map(String::as_str),
                    &message.images,
                )?;
                if !message.images.is_empty() && result["type"] == "function_call_output" {
                    result["output"] = json!(message_content(message, "input_text")?);
                }
                input.push(result);
            }
        }
    }
    Ok(input)
}

fn tool_result_item(
    call_id: &str,
    content: &str,
    call_type: Option<&str>,
    images: &[ChatImage],
) -> Result<Value, ProviderError> {
    match call_type {
        Some("apply_patch_call") => {
            let payload = serde_json::from_str::<Value>(content).unwrap_or(Value::Null);
            let failed = payload.get("error").is_some()
                || payload.get("rejected").is_some()
                || payload.get("status").and_then(Value::as_str) == Some("failed");
            Ok(json!({
                "type": "apply_patch_call_output",
                "call_id": call_id,
                "status": if failed { "failed" } else { "completed" },
                "output": content,
            }))
        }
        Some("shell_call") => Ok(shell_result_item(call_id, content)),
        Some("local_shell_call") => Ok(json!({
            "type": "local_shell_call_output",
            "call_id": call_id,
            "output": content,
        })),
        Some("computer_call") => computer_result_item(call_id, images),
        _ => Ok(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": content,
        })),
    }
}

fn computer_result_item(call_id: &str, images: &[ChatImage]) -> Result<Value, ProviderError> {
    let Some(image) = images.first() else {
        return Err(ProviderError::InvalidResponse(format!(
            "computer_call {call_id} completed without a screenshot"
        )));
    };
    let image = encode_image(image)?;
    Ok(json!({
        "type": "computer_call_output",
        "call_id": call_id,
        "output": {
            "type": "computer_screenshot",
            "image_url": format!("data:{};base64,{}", image.mime_type, image.base64),
        },
    }))
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
