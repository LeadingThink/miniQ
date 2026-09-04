//! Native Anthropic Messages API adapter.

use std::collections::{BTreeMap, HashSet};

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use crate::image::encode_image;
use crate::provider::{
    ApiProtocol, ChatDelta, ChatMessage, ChatRole, CompletionRequest, DeltaStream, ModelProvider,
    ProviderConfig, ProviderContext, ProviderError, ToolCallRequest,
};
use crate::sse::{self, DecodedEvent, EventDecoder};

pub struct AnthropicProvider {
    config: ProviderConfig,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(30))
                .read_timeout(std::time::Duration::from_secs(620))
                .build()
                .expect("valid HTTP client configuration"),
        }
    }

    fn try_build_body(&self, request: &CompletionRequest) -> Result<Value, ProviderError> {
        let (system, messages) = build_messages(&request.messages)?;
        let mut body = json!({
            "model": self.config.model,
            "messages": messages,
            "max_tokens": request.max_output_tokens.unwrap_or(16_384),
            "stream": true,
        });
        if !system.is_empty() {
            body["system"] = Value::String(system);
        }
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "name": tool.name.replace('.', "_"),
                            "description": tool.description,
                            "input_schema": anthropic_input_schema(&tool.parameters),
                        })
                    })
                    .collect(),
            );
        }
        Ok(body)
    }

    #[cfg(test)]
    fn build_body(&self, request: &CompletionRequest) -> Value {
        self.try_build_body(request).unwrap()
    }
}

/// Anthropic requires every tool input schema to be an object and rejects
/// `oneOf`, `anyOf`, and `allOf` when they appear at the schema root. Keep the
/// available fields in the wire schema; the tool runtime remains authoritative
/// for cross-field validation that Anthropic cannot express.
fn anthropic_input_schema(schema: &Value) -> Value {
    let Some(source) = schema.as_object() else {
        return json!({"type": "object", "properties": {}});
    };
    let mut normalized = source.clone();
    let mut properties = normalized
        .remove("properties")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    for keyword in ["oneOf", "anyOf", "allOf"] {
        let Some(variants) = normalized
            .remove(keyword)
            .and_then(|value| value.as_array().cloned())
        else {
            continue;
        };
        for variant in variants {
            let Some(variant_properties) = variant.get("properties").and_then(Value::as_object)
            else {
                continue;
            };
            for (name, definition) in variant_properties {
                properties
                    .entry(name.clone())
                    .or_insert_with(|| definition.clone());
            }
        }
    }

    normalized.insert("type".into(), Value::String("object".into()));
    normalized.insert("properties".into(), Value::Object(properties));
    Value::Object(normalized)
}

fn content_blocks(message: &ChatMessage, text_type: &str) -> Result<Vec<Value>, ProviderError> {
    let mut blocks = Vec::with_capacity(message.images.len() + 1);
    if !message.content.is_empty() {
        blocks.push(json!({ "type": text_type, "text": message.content }));
    }
    for image in &message.images {
        let image = encode_image(image)?;
        blocks.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.mime_type,
                "data": image.base64,
            }
        }));
    }
    Ok(blocks)
}

fn push_message(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
                content.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({ "role": role, "content": blocks }));
}

fn build_messages(messages: &[ChatMessage]) -> Result<(String, Vec<Value>), ProviderError> {
    let mut system = Vec::new();
    let mut output = Vec::new();
    for message in messages {
        match message.role {
            ChatRole::System => system.push(message.content.clone()),
            ChatRole::User => push_message(&mut output, "user", content_blocks(message, "text")?),
            ChatRole::Tool => {
                let tool_use_id = message.tool_call_id.as_deref().ok_or_else(|| {
                    ProviderError::InvalidResponse("tool result is missing its tool_use_id".into())
                })?;
                let parsed = serde_json::from_str::<Value>(&message.content).unwrap_or(Value::Null);
                let is_error = parsed.get("error").is_some()
                    || parsed.get("rejected").is_some()
                    || parsed.get("cancelled").and_then(Value::as_bool) == Some(true);
                push_message(
                    &mut output,
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": message.content,
                        "is_error": is_error,
                    })],
                );
            }
            ChatRole::Assistant => {
                if let Some(context) = &message.provider_context {
                    if context.protocol == ApiProtocol::AnthropicMessages {
                        let blocks = context.data.as_array().ok_or_else(|| {
                            ProviderError::InvalidResponse(
                                "Anthropic provider context must be an array".into(),
                            )
                        })?;
                        push_message(&mut output, "assistant", blocks.clone());
                        continue;
                    }
                }
                let mut blocks = content_blocks(message, "text")?;
                blocks.extend(message.tool_calls.iter().map(|call| {
                    json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    })
                }));
                push_message(&mut output, "assistant", blocks);
            }
        }
    }
    Ok((system.join("\n\n"), output))
}

#[derive(Default)]
struct ContentBlock {
    value: Value,
    partial_json: String,
}

#[derive(Default)]
struct AnthropicDecoder {
    blocks: BTreeMap<usize, ContentBlock>,
    emitted_tools: HashSet<usize>,
}

impl AnthropicDecoder {
    fn start_block(&mut self, event: &Value) -> Vec<Result<ChatDelta, ProviderError>> {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let value = event
            .get("content_block")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let initial_text = value
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        self.blocks.insert(
            index,
            ContentBlock {
                value,
                partial_json: String::new(),
            },
        );
        initial_text
            .map(|text| Ok(ChatDelta::Text(text)))
            .into_iter()
            .collect()
    }

    fn apply_delta(&mut self, event: &Value) -> Vec<Result<ChatDelta, ProviderError>> {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let Some(delta) = event.get("delta") else {
            return Vec::new();
        };
        let block = self.blocks.entry(index).or_default();
        match delta.get("type").and_then(Value::as_str).unwrap_or("") {
            "text_delta" => {
                let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                append_string(&mut block.value, "text", text);
                (!text.is_empty())
                    .then(|| Ok(ChatDelta::Text(text.to_string())))
                    .into_iter()
                    .collect()
            }
            "input_json_delta" => {
                if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                    block.partial_json.push_str(partial);
                }
                Vec::new()
            }
            "thinking_delta" => {
                append_string(
                    &mut block.value,
                    "thinking",
                    delta.get("thinking").and_then(Value::as_str).unwrap_or(""),
                );
                Vec::new()
            }
            "signature_delta" => {
                append_string(
                    &mut block.value,
                    "signature",
                    delta.get("signature").and_then(Value::as_str).unwrap_or(""),
                );
                Vec::new()
            }
            "citations_delta" => {
                if let Some(citation) = delta.get("citation") {
                    if let Some(citations) = object_mut(&mut block.value)
                        .entry("citations")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                    {
                        citations.push(citation.clone());
                    }
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn stop_block(&mut self, event: &Value) -> Vec<Result<ChatDelta, ProviderError>> {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        if self.emitted_tools.contains(&index) {
            return Vec::new();
        }
        let Some(block) = self.blocks.get_mut(&index) else {
            return Vec::new();
        };
        if block.value.get("type").and_then(Value::as_str) != Some("tool_use") {
            return Vec::new();
        }
        let id = block
            .value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let name = block
            .value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() || name.is_empty() {
            return vec![Err(ProviderError::InvalidResponse(format!(
                "Anthropic tool_use block {index} is missing id or name"
            )))];
        }
        let input = if block.partial_json.trim().is_empty() {
            block
                .value
                .get("input")
                .cloned()
                .unwrap_or_else(|| json!({}))
        } else {
            match serde_json::from_str(&block.partial_json) {
                Ok(input) => input,
                Err(error) => {
                    return vec![Err(ProviderError::IncompleteToolArguments {
                        tool: name.clone(),
                        detail: error.to_string(),
                    })]
                }
            }
        };
        object_mut(&mut block.value).insert("input".into(), input.clone());
        self.emitted_tools.insert(index);
        vec![Ok(ChatDelta::ToolCall(ToolCallRequest {
            id,
            name,
            arguments: input,
        }))]
    }

    fn finish_message(&mut self) -> DecodedEvent {
        let context = self
            .blocks
            .values()
            .map(|block| block.value.clone())
            .collect::<Vec<_>>();
        let mut items = Vec::new();
        if !context.is_empty() {
            items.push(Ok(ChatDelta::Context(ProviderContext {
                protocol: ApiProtocol::AnthropicMessages,
                data: Value::Array(context),
            })));
        }
        items.push(Ok(ChatDelta::Finished));
        DecodedEvent::terminal(items)
    }
}

fn object_mut(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    value.as_object_mut().expect("value initialized as object")
}

fn append_string(value: &mut Value, field: &str, delta: &str) {
    let entry = object_mut(value)
        .entry(field)
        .or_insert_with(|| Value::String(String::new()));
    if let Some(current) = entry.as_str() {
        *entry = Value::String(format!("{current}{delta}"));
    }
}

fn anthropic_error(event: &Value) -> ProviderError {
    let detail = event
        .pointer("/error/message")
        .or_else(|| event.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("provider returned an unspecified Anthropic error");
    ProviderError::InvalidResponse(format!("Anthropic Messages API error: {detail}"))
}

impl EventDecoder for AnthropicDecoder {
    fn decode(&mut self, raw_event: &str) -> DecodedEvent {
        let Some(data) = sse::event_data(raw_event) else {
            return DecodedEvent::continue_with(Vec::new());
        };
        let event: Value = match serde_json::from_str(&data) {
            Ok(event) => event,
            Err(error) => {
                return DecodedEvent::terminal(vec![Err(ProviderError::InvalidResponse(format!(
                    "bad Anthropic SSE event: {error}"
                )))])
            }
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "content_block_start" => DecodedEvent::continue_with(self.start_block(&event)),
            "content_block_delta" => DecodedEvent::continue_with(self.apply_delta(&event)),
            "content_block_stop" => DecodedEvent::continue_with(self.stop_block(&event)),
            "message_delta" => {
                let reason = event.pointer("/delta/stop_reason").and_then(Value::as_str);
                match reason {
                    Some("max_tokens") => {
                        DecodedEvent::terminal(vec![Err(ProviderError::OutputLimitReached)])
                    }
                    Some("model_context_window_exceeded") => {
                        DecodedEvent::terminal(vec![Err(ProviderError::InvalidResponse(
                            "Anthropic model context window was exceeded".into(),
                        ))])
                    }
                    _ => DecodedEvent::continue_with(Vec::new()),
                }
            }
            "message_stop" => self.finish_message(),
            "error" => DecodedEvent::terminal(vec![Err(anthropic_error(&event))]),
            _ => DecodedEvent::continue_with(Vec::new()),
        }
    }

    fn finish(&mut self) -> Vec<Result<ChatDelta, ProviderError>> {
        vec![Err(ProviderError::IncompleteStream)]
    }
}

#[async_trait]
impl ModelProvider for AnthropicProvider {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let url = format!("{}/messages", self.config.base_url.trim_end_matches('/'));
        let mut builder = self
            .client
            .post(url)
            .header("anthropic-version", "2023-06-01")
            .json(&self.try_build_body(&request)?);
        if !self.config.api_key.is_empty() {
            builder = builder.header("x-api-key", &self.config.api_key);
        }
        let response = builder.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ProviderError::Api { status, body });
        }
        Ok(sse::response_stream(response, AnthropicDecoder::default()))
    }

    fn describe(&self) -> String {
        format!(
            "anthropic-messages {} @ {}",
            self.config.model, self.config.base_url
        )
    }
}

#[cfg(test)]
mod tests;
