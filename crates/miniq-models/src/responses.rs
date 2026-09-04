//! Native OpenAI Responses API adapter.

use std::collections::{BTreeMap, HashSet};

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::image::encode_image;
use crate::provider::{
    ApiProtocol, ChatDelta, ChatMessage, ChatRole, CompletionRequest, DeltaStream, ModelProvider,
    ProviderConfig, ProviderContext, ProviderError, ToolCallRequest,
};
use crate::sse::{self, DecodedEvent, EventDecoder};

pub struct ResponsesProvider {
    config: ProviderConfig,
    client: reqwest::Client,
}

impl ResponsesProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            config,
            client: provider_client(),
        }
    }

    fn try_build_body(&self, request: &CompletionRequest) -> Result<Value, ProviderError> {
        let mut body = json!({
            "model": self.config.model,
            "input": build_input(&request.messages)?,
            "stream": true,
            "store": false,
            "include": ["reasoning.encrypted_content"],
        });
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_output_tokens) = request.max_output_tokens {
            body["max_output_tokens"] = json!(max_output_tokens);
        }
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "name": tool.name.replace('.', "_"),
                            "description": tool.description,
                            "parameters": tool.parameters,
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

fn provider_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(620))
        .build()
        .expect("valid HTTP client configuration")
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
        let image = encode_image(image)?;
        content.push(json!({
            "type": "input_image",
            "image_url": format!("data:{};base64,{}", image.mime_type, image.base64),
            "detail": "auto",
        }));
    }
    Ok(content)
}

fn build_input(messages: &[ChatMessage]) -> Result<Vec<Value>, ProviderError> {
    let mut input = Vec::new();
    for message in messages {
        if message.role == ChatRole::Assistant {
            if let Some(context) = &message.provider_context {
                if context.protocol == ApiProtocol::Responses {
                    let items = context.data.as_array().ok_or_else(|| {
                        ProviderError::InvalidResponse(
                            "Responses provider context must be an array".into(),
                        )
                    })?;
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
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": message.content,
                }));
            }
        }
    }
    Ok(input)
}

#[derive(Default)]
struct PendingCall {
    item_id: String,
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct ResponsesDecoder {
    calls: BTreeMap<usize, PendingCall>,
    output_items: BTreeMap<usize, Value>,
    emitted_calls: HashSet<String>,
}

impl ResponsesDecoder {
    fn call_index(&self, event: &Value) -> usize {
        if let Some(index) = event.get("output_index").and_then(Value::as_u64) {
            return index as usize;
        }
        let item_id = event.get("item_id").and_then(Value::as_str).unwrap_or("");
        self.calls
            .iter()
            .find_map(|(index, call)| (call.item_id == item_id).then_some(*index))
            .unwrap_or(self.calls.len())
    }

    fn update_call_from_item(&mut self, index: usize, item: &Value) {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return;
        }
        let call = self.calls.entry(index).or_default();
        set_string(&mut call.item_id, item.get("id"));
        set_string(&mut call.call_id, item.get("call_id"));
        set_string(&mut call.name, item.get("name"));
        if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
            call.arguments = arguments.to_string();
        }
    }

    fn emit_call(&mut self, index: usize) -> Option<Result<ChatDelta, ProviderError>> {
        let call = self.calls.get(&index)?;
        let dedupe_key = if call.call_id.is_empty() {
            call.item_id.clone()
        } else {
            call.call_id.clone()
        };
        if self.emitted_calls.contains(&dedupe_key) {
            return None;
        }
        if call.call_id.is_empty() || call.name.is_empty() {
            return Some(Err(ProviderError::InvalidResponse(format!(
                "Responses function call at output index {index} is missing call_id or name"
            ))));
        }
        let arguments = match parse_arguments(&call.name, &call.arguments) {
            Ok(arguments) => arguments,
            Err(error) => return Some(Err(error)),
        };
        self.emitted_calls.insert(dedupe_key);
        Some(Ok(ChatDelta::ToolCall(ToolCallRequest {
            id: call.call_id.clone(),
            name: call.name.clone(),
            arguments,
        })))
    }

    fn completed(&mut self, event: &Value) -> DecodedEvent {
        if let Some(output) = event.pointer("/response/output").and_then(Value::as_array) {
            self.output_items.clear();
            for (index, item) in output.iter().enumerate() {
                self.update_call_from_item(index, item);
                self.output_items.insert(index, item.clone());
            }
        }
        let mut items = self
            .calls
            .keys()
            .copied()
            .collect::<Vec<_>>()
            .into_iter()
            .filter_map(|index| self.emit_call(index))
            .collect::<Vec<_>>();
        let context = self.output_items.values().cloned().collect::<Vec<_>>();
        if !context.is_empty() {
            items.push(Ok(ChatDelta::Context(ProviderContext {
                protocol: ApiProtocol::Responses,
                data: Value::Array(context),
            })));
        }
        items.push(Ok(ChatDelta::Finished));
        DecodedEvent::terminal(items)
    }
}

fn set_string(target: &mut String, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        *target = value.to_string();
    }
}

fn parse_arguments(tool: &str, arguments: &str) -> Result<Value, ProviderError> {
    if arguments.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(arguments).map_err(|error| ProviderError::IncompleteToolArguments {
        tool: tool.to_string(),
        detail: error.to_string(),
    })
}

fn error_detail(event: &Value) -> String {
    event
        .pointer("/response/error/message")
        .or_else(|| event.pointer("/error/message"))
        .or_else(|| event.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("provider returned an unspecified Responses API error")
        .to_string()
}

impl EventDecoder for ResponsesDecoder {
    fn decode(&mut self, raw_event: &str) -> DecodedEvent {
        let Some(data) = sse::event_data(raw_event) else {
            return DecodedEvent::continue_with(Vec::new());
        };
        if data == "[DONE]" {
            return DecodedEvent::continue_with(Vec::new());
        }
        let event: Value = match serde_json::from_str(&data) {
            Ok(event) => event,
            Err(error) => {
                return DecodedEvent::terminal(vec![Err(ProviderError::InvalidResponse(format!(
                    "bad Responses SSE event: {error}"
                )))])
            }
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "response.output_text.delta" | "response.refusal.delta" => {
                let text = event.get("delta").and_then(Value::as_str).unwrap_or("");
                DecodedEvent::continue_with(
                    (!text.is_empty())
                        .then(|| Ok(ChatDelta::Text(text.to_string())))
                        .into_iter()
                        .collect(),
                )
            }
            "response.output_item.added" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if let Some(item) = event.get("item") {
                    self.update_call_from_item(index, item);
                    self.output_items.insert(index, item.clone());
                }
                DecodedEvent::continue_with(Vec::new())
            }
            "response.function_call_arguments.delta" => {
                let index = self.call_index(&event);
                let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                self.calls
                    .entry(index)
                    .or_default()
                    .arguments
                    .push_str(delta);
                DecodedEvent::continue_with(Vec::new())
            }
            "response.function_call_arguments.done" => {
                let index = self.call_index(&event);
                if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                    self.calls.entry(index).or_default().arguments = arguments.to_string();
                }
                DecodedEvent::continue_with(Vec::new())
            }
            "response.output_item.done" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                if let Some(item) = event.get("item") {
                    self.update_call_from_item(index, item);
                    self.output_items.insert(index, item.clone());
                }
                DecodedEvent::continue_with(self.emit_call(index).into_iter().collect())
            }
            "response.completed" => self.completed(&event),
            "response.incomplete" => {
                let reason = event
                    .pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let error = if reason == "max_output_tokens" {
                    ProviderError::OutputLimitReached
                } else {
                    ProviderError::InvalidResponse(format!(
                        "Responses API returned an incomplete response: {reason}"
                    ))
                };
                DecodedEvent::terminal(vec![Err(error)])
            }
            "response.failed" | "error" => {
                DecodedEvent::terminal(vec![Err(ProviderError::InvalidResponse(format!(
                    "Responses API error: {}",
                    error_detail(&event)
                )))])
            }
            _ => DecodedEvent::continue_with(Vec::new()),
        }
    }

    fn finish(&mut self) -> Vec<Result<ChatDelta, ProviderError>> {
        vec![Err(ProviderError::IncompleteStream)]
    }
}

#[async_trait]
impl ModelProvider for ResponsesProvider {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let url = format!("{}/responses", self.config.base_url.trim_end_matches('/'));
        let mut builder = self.client.post(url).json(&self.try_build_body(&request)?);
        if !self.config.api_key.is_empty() {
            builder = builder.bearer_auth(&self.config.api_key);
        }
        let response = builder.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ProviderError::Api { status, body });
        }
        Ok(sse::response_stream(response, ResponsesDecoder::default()))
    }

    fn describe(&self) -> String {
        format!("responses {} @ {}", self.config.model, self.config.base_url)
    }
}

#[cfg(test)]
mod tests;
