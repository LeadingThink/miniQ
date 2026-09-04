//! OpenAI-compatible chat completions adapter with SSE streaming.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::image::encode_image;
use crate::provider::{
    ChatDelta, ChatImage, ChatMessage, ChatRole, CompletionRequest, DeltaStream, ModelProvider,
    ProviderConfig, ProviderError, ToolCallRequest,
};
use crate::sse::{self, DecodedEvent, EventDecoder};

pub struct OpenAiCompatProvider {
    config: ProviderConfig,
    client: reqwest::Client,
}

/// OpenAI function names must match `^[a-zA-Z0-9_-]+$`. miniQ tool names are
/// snake_case and already conform; this defensive normalization keeps any
/// future dotted name from producing a provider 400.
fn wire_name(name: &str) -> String {
    name.replace('.', "_")
}

impl OpenAiCompatProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(30))
                // The production relay permits a model stream to stay quiet
                // for 600 seconds. Bound dead connections just above that
                // limit so the agent can surface and retry a real failure.
                .read_timeout(std::time::Duration::from_secs(620))
                .build()
                .expect("valid HTTP client configuration"),
        }
    }

    fn try_build_body(&self, request: &CompletionRequest) -> Result<Value, ProviderError> {
        let messages = request
            .messages
            .iter()
            .map(message_to_json)
            .collect::<Result<Vec<_>, _>>()?;
        let mut body = json!({
            "model": self.config.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(t) = request.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(max_output_tokens) = request.max_output_tokens {
            body["max_tokens"] = json!(max_output_tokens);
        }
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|t| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": wire_name(&t.name),
                                "description": t.description,
                                "parameters": t.parameters,
                            }
                        })
                    })
                    .collect(),
            );
        }
        Ok(body)
    }

    #[cfg(test)]
    fn build_body(&self, request: &CompletionRequest) -> Value {
        self.try_build_body(request)
            .expect("test request should be valid")
    }
}

fn image_to_json(image: &ChatImage) -> Result<Value, ProviderError> {
    let image = encode_image(image)?;
    Ok(json!({
        "type": "image_url",
        "image_url": {
            "url": format!("data:{};base64,{}", image.mime_type, image.base64),
            "detail": "auto"
        }
    }))
}

fn message_to_json(msg: &ChatMessage) -> Result<Value, ProviderError> {
    let role = match msg.role {
        ChatRole::System => "system",
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::Tool => "tool",
    };
    let content = if msg.images.is_empty() {
        Value::String(msg.content.clone())
    } else {
        let mut parts = Vec::with_capacity(msg.images.len() + 1);
        if !msg.content.trim().is_empty() {
            parts.push(json!({ "type": "text", "text": msg.content }));
        }
        for image in &msg.images {
            parts.push(image_to_json(image)?);
        }
        Value::Array(parts)
    };
    let mut v = json!({ "role": role, "content": content });
    if let Some(id) = &msg.tool_call_id {
        v["tool_call_id"] = json!(id);
    }
    if !msg.tool_calls.is_empty() {
        v["tool_calls"] = Value::Array(
            msg.tool_calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "type": "function",
                        "function": {
                            "name": c.name,
                            "arguments": c.arguments.to_string(),
                        }
                    })
                })
                .collect(),
        );
    }
    Ok(v)
}

/// Partially accumulated tool call from streamed fragments.
#[derive(Default, Clone)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<StreamToolCall>>,
    #[serde(default)]
    function_call: Option<StreamToolFunction>,
}

#[derive(Deserialize)]
struct StreamToolCall {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<StreamToolFunction>,
}

#[derive(Deserialize)]
struct StreamToolFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

fn flush_tool_calls(pending: &mut Vec<PendingToolCall>) -> Vec<Result<ChatDelta, ProviderError>> {
    static NEXT_SYNTHETIC_ID: AtomicU64 = AtomicU64::new(1);
    let calls = std::mem::take(pending);
    calls
        .into_iter()
        .enumerate()
        .map(|(index, c)| {
            if c.name.trim().is_empty() {
                return Err(ProviderError::InvalidResponse(format!(
                    "tool call at index {index} is missing a function name"
                )));
            }
            let arguments: Value = if c.arguments.trim().is_empty() {
                json!({})
            } else {
                match serde_json::from_str(&c.arguments) {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(ProviderError::IncompleteToolArguments {
                            tool: c.name,
                            detail: e.to_string(),
                        })
                    }
                }
            };
            Ok(ChatDelta::ToolCall(ToolCallRequest {
                id: if c.id.is_empty() {
                    format!(
                        "miniq-call-{}",
                        NEXT_SYNTHETIC_ID.fetch_add(1, Ordering::Relaxed)
                    )
                } else {
                    c.id
                },
                name: c.name,
                arguments,
            }))
        })
        .collect()
}

fn decode_choice(
    choice: StreamChoice,
    pending: &mut Vec<PendingToolCall>,
    saw_finish_reason: &mut bool,
    deltas: &mut Vec<Result<ChatDelta, ProviderError>>,
) -> bool {
    if let Some(text) = choice.delta.content {
        if !text.is_empty() {
            deltas.push(Ok(ChatDelta::Text(text)));
        }
    }
    if let Some(tool_calls) = choice.delta.tool_calls {
        for tool_call in tool_calls {
            if pending.len() <= tool_call.index {
                pending.resize(tool_call.index + 1, PendingToolCall::default());
            }
            let slot = &mut pending[tool_call.index];
            if let Some(id) = tool_call.id {
                slot.id = id;
            }
            if let Some(function) = tool_call.function {
                if let Some(name) = function.name {
                    slot.name.push_str(&name);
                }
                if let Some(arguments) = function.arguments {
                    slot.arguments.push_str(&arguments);
                }
            }
        }
    }
    if let Some(function) = choice.delta.function_call {
        if pending.is_empty() {
            pending.push(PendingToolCall::default());
        }
        if let Some(name) = function.name {
            pending[0].name.push_str(&name);
        }
        if let Some(arguments) = function.arguments {
            pending[0].arguments.push_str(&arguments);
        }
    }
    let Some(reason) = choice.finish_reason else {
        return false;
    };
    *saw_finish_reason = true;
    match reason.as_str() {
        "stop" | "tool_calls" | "function_call" => deltas.extend(flush_tool_calls(pending)),
        "length" | "max_tokens" => {
            deltas.push(Err(ProviderError::OutputLimitReached));
            return true;
        }
        "content_filter" => {
            deltas.push(Err(ProviderError::InvalidResponse(
                "provider blocked the completion with content_filter".to_string(),
            )));
            return true;
        }
        other => {
            deltas.push(Err(ProviderError::InvalidResponse(format!(
                "unsupported finish_reason: {other}"
            ))));
            return true;
        }
    }
    false
}

fn decode_sse_event(
    event: &str,
    pending: &mut Vec<PendingToolCall>,
    saw_finish_reason: &mut bool,
) -> (Vec<Result<ChatDelta, ProviderError>>, bool) {
    let mut deltas = Vec::new();
    let Some(data) = sse::event_data(event) else {
        return (deltas, false);
    };
    if data == "[DONE]" {
        deltas.extend(flush_tool_calls(pending));
        deltas.push(Ok(ChatDelta::Finished));
        return (deltas, true);
    }
    let parsed: StreamChunk = match serde_json::from_str(&data) {
        Ok(parsed) => parsed,
        Err(error) => {
            deltas.push(Err(ProviderError::InvalidResponse(format!(
                "bad SSE chunk: {error}"
            ))));
            return (deltas, true);
        }
    };
    if let Some(error) = parsed.error {
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        deltas.push(Err(ProviderError::InvalidResponse(format!(
            "provider stream error: {detail}"
        ))));
        return (deltas, true);
    }
    for choice in parsed.choices {
        if decode_choice(choice, pending, saw_finish_reason, &mut deltas) {
            return (deltas, true);
        }
    }
    (deltas, false)
}

#[derive(Default)]
struct ChatCompletionsDecoder {
    pending: Vec<PendingToolCall>,
    saw_finish_reason: bool,
}

impl EventDecoder for ChatCompletionsDecoder {
    fn decode(&mut self, event: &str) -> DecodedEvent {
        let (items, terminal) =
            decode_sse_event(event, &mut self.pending, &mut self.saw_finish_reason);
        if terminal {
            DecodedEvent::terminal(items)
        } else {
            DecodedEvent::continue_with(items)
        }
    }

    fn finish(&mut self) -> Vec<Result<ChatDelta, ProviderError>> {
        if !self.saw_finish_reason {
            return vec![Err(ProviderError::IncompleteStream)];
        }
        let mut items = flush_tool_calls(&mut self.pending);
        items.push(Ok(ChatDelta::Finished));
        items
    }
}

#[async_trait]
impl ModelProvider for OpenAiCompatProvider {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let url = format!(
            "{}/chat/completions",
            self.config.base_url.trim_end_matches('/')
        );
        let body = self.try_build_body(&request)?;
        let mut req = self.client.post(&url).json(&body);
        if !self.config.api_key.is_empty() {
            req = req.bearer_auth(&self.config.api_key);
        }
        let response = req.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ProviderError::Api { status, body });
        }

        Ok(sse::response_stream(
            response,
            ChatCompletionsDecoder::default(),
        ))
    }

    fn describe(&self) -> String {
        format!(
            "openai-compat {} @ {}",
            self.config.model, self.config.base_url
        )
    }
}

#[cfg(test)]
mod tests;
