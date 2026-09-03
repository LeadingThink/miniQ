//! OpenAI-compatible chat completions adapter with SSE streaming.

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::provider::{
    ChatDelta, ChatMessage, ChatRole, CompletionRequest, DeltaStream, ModelProvider,
    ProviderConfig, ProviderError, ToolCallRequest,
};

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
            client: reqwest::Client::new(),
        }
    }

    fn build_body(&self, request: &CompletionRequest) -> Value {
        let messages: Vec<Value> = request.messages.iter().map(message_to_json).collect();
        let mut body = json!({
            "model": self.config.model,
            "messages": messages,
            "stream": true,
            "reasoning_effort": "high",
        });
        if let Some(t) = request.temperature {
            body["temperature"] = json!(t);
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
        body
    }
}

fn message_to_json(msg: &ChatMessage) -> Value {
    let role = match msg.role {
        ChatRole::System => "system",
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::Tool => "tool",
    };
    let content = if msg.images.is_empty() {
        json!(msg.content)
    } else {
        let mut parts = Vec::with_capacity(msg.images.len() + 1);
        if !msg.content.is_empty() {
            parts.push(json!({ "type": "text", "text": msg.content }));
        }
        parts.extend(msg.images.iter().map(|image| {
            json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:{};base64,{}", image.media_type, image.data)
                }
            })
        }));
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
    v
}

#[cfg(test)]
mod tests {
    use super::{message_to_json, OpenAiCompatProvider, StreamChunk};
    use crate::provider::{
        ChatMessage, CompletionRequest, ImageAttachment, ProviderConfig, ToolSpec,
    };
    use serde_json::json;

    #[test]
    fn serializes_plain_text_as_string_content() {
        assert_eq!(
            message_to_json(&ChatMessage::user("hello")),
            json!({ "role": "user", "content": "hello" })
        );
    }

    #[test]
    fn requests_high_reasoning_effort_for_tool_turns() {
        let provider = OpenAiCompatProvider::new(ProviderConfig {
            base_url: "https://example.com/v1".to_string(),
            api_key: String::new(),
            model: "reasoning-model".to_string(),
        });
        let request = CompletionRequest {
            messages: vec![ChatMessage::user("inspect")],
            tools: vec![ToolSpec {
                name: "inspect".to_string(),
                description: "Inspect a value".to_string(),
                parameters: json!({ "type": "object" }),
            }],
            temperature: None,
        };

        assert_eq!(provider.build_body(&request)["reasoning_effort"], "high");
    }

    #[test]
    fn serializes_images_as_multimodal_content() {
        let mut message = ChatMessage::user("What is shown here?");
        message.images.push(ImageAttachment {
            media_type: "image/png".to_string(),
            data: "aGVsbG8=".to_string(),
        });

        assert_eq!(
            message_to_json(&message),
            json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "What is shown here?" },
                    {
                        "type": "image_url",
                        "image_url": { "url": "data:image/png;base64,aGVsbG8=" }
                    }
                ]
            })
        );
    }

    #[test]
    fn deserializes_provider_reasoning_fields() {
        let reasoning_content: StreamChunk = serde_json::from_value(json!({
            "choices": [{ "delta": { "reasoning_content": "first" } }]
        }))
        .unwrap();
        let reasoning: StreamChunk = serde_json::from_value(json!({
            "choices": [{ "delta": { "reasoning": "second" } }]
        }))
        .unwrap();

        assert_eq!(
            reasoning_content.choices[0]
                .delta
                .reasoning_content
                .as_deref(),
            Some("first")
        );
        assert_eq!(
            reasoning.choices[0].delta.reasoning.as_deref(),
            Some("second")
        );

        let details: StreamChunk = serde_json::from_value(json!({
            "choices": [{
                "delta": {
                    "reasoning_details": [
                        { "type": "reasoning.text", "text": "third" },
                        { "type": "thinking", "content": "fourth" }
                    ],
                    "content": [
                        { "type": "reasoning", "text": "fifth" },
                        { "type": "text", "text": "answer" }
                    ]
                }
            }]
        }))
        .unwrap();

        assert_eq!(details.choices[0].delta.reasoning_details.len(), 2);
        assert!(matches!(
            details.choices[0].delta.content,
            Some(super::StreamContent::Blocks(ref blocks)) if blocks.len() == 2
        ));
    }
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
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    reasoning_details: Vec<ReasoningDetail>,
    #[serde(default)]
    content: Option<StreamContent>,
    #[serde(default)]
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StreamContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ReasoningDetail {
    Text(String),
    Detail {
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        content: Option<String>,
    },
}

impl ReasoningDetail {
    fn into_text(self) -> Option<String> {
        match self {
            Self::Text(text) => Some(text),
            Self::Detail { text, content } => text.or(content),
        }
    }
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
    let calls = std::mem::take(pending);
    calls
        .into_iter()
        .filter(|c| !c.name.is_empty())
        .map(|c| {
            let arguments: Value = if c.arguments.trim().is_empty() {
                json!({})
            } else {
                match serde_json::from_str(&c.arguments) {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(ProviderError::InvalidResponse(format!(
                            "tool call {} has invalid JSON arguments: {e}",
                            c.name
                        )))
                    }
                }
            };
            Ok(ChatDelta::ToolCall(ToolCallRequest {
                id: c.id,
                name: c.name,
                arguments,
            }))
        })
        .collect()
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
        let mut req = self.client.post(&url).json(&self.build_body(&request));
        if !self.config.api_key.is_empty() {
            req = req.bearer_auth(&self.config.api_key);
        }
        let response = req.send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ProviderError::Api { status, body });
        }

        let stream = async_stream_sse(response);
        Ok(Box::pin(stream))
    }

    fn describe(&self) -> String {
        format!(
            "openai-compat {} @ {}",
            self.config.model, self.config.base_url
        )
    }
}

/// Turn the SSE byte stream into `ChatDelta`s. Accumulates tool call
/// fragments and flushes them when the stream reports a finish reason or
/// ends.
fn async_stream_sse(
    response: reqwest::Response,
) -> impl futures_util::Stream<Item = Result<ChatDelta, ProviderError>> {
    async_stream(move |emit| async move {
        let mut buffer = String::new();
        let mut pending: Vec<PendingToolCall> = Vec::new();
        let mut byte_stream = response.bytes_stream();

        while let Some(chunk) = byte_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    emit(Err(ProviderError::Http(e))).await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // SSE events are separated by a blank line.
            while let Some(pos) = buffer.find("\n\n") {
                let event = buffer[..pos].to_string();
                buffer.drain(..pos + 2);
                for line in event.lines() {
                    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                        continue;
                    };
                    if data == "[DONE]" {
                        for d in flush_tool_calls(&mut pending) {
                            emit(d).await;
                        }
                        emit(Ok(ChatDelta::Finished)).await;
                        return;
                    }
                    let parsed: StreamChunk = match serde_json::from_str(data) {
                        Ok(p) => p,
                        Err(e) => {
                            emit(Err(ProviderError::InvalidResponse(format!(
                                "bad SSE chunk: {e}"
                            ))))
                            .await;
                            return;
                        }
                    };
                    for choice in parsed.choices {
                        let mut reasoning_parts = Vec::new();
                        reasoning_parts.extend(
                            [choice.delta.reasoning_content, choice.delta.reasoning]
                                .into_iter()
                                .flatten(),
                        );
                        reasoning_parts.extend(
                            choice
                                .delta
                                .reasoning_details
                                .into_iter()
                                .filter_map(ReasoningDetail::into_text),
                        );
                        for reasoning in reasoning_parts {
                            if !reasoning.is_empty() {
                                emit(Ok(ChatDelta::Reasoning(reasoning))).await;
                            }
                        }
                        if let Some(content) = choice.delta.content {
                            match content {
                                StreamContent::Text(text) if !text.is_empty() => {
                                    emit(Ok(ChatDelta::Text(text))).await;
                                }
                                StreamContent::Blocks(blocks) => {
                                    for block in blocks {
                                        let Some(text) = block.text.or(block.content) else {
                                            continue;
                                        };
                                        if text.is_empty() {
                                            continue;
                                        }
                                        if matches!(
                                            block.kind.as_str(),
                                            "reasoning" | "thinking" | "analysis"
                                        ) {
                                            emit(Ok(ChatDelta::Reasoning(text))).await;
                                        } else if block.kind == "text" {
                                            emit(Ok(ChatDelta::Text(text))).await;
                                        }
                                    }
                                }
                                StreamContent::Text(_) => {}
                            }
                        }
                        if let Some(tool_calls) = choice.delta.tool_calls {
                            for tc in tool_calls {
                                if pending.len() <= tc.index {
                                    pending.resize(tc.index + 1, PendingToolCall::default());
                                }
                                let slot = &mut pending[tc.index];
                                if let Some(id) = tc.id {
                                    slot.id = id;
                                }
                                if let Some(f) = tc.function {
                                    if let Some(name) = f.name {
                                        slot.name.push_str(&name);
                                    }
                                    if let Some(args) = f.arguments {
                                        slot.arguments.push_str(&args);
                                    }
                                }
                            }
                        }
                        if choice.finish_reason.is_some() {
                            for d in flush_tool_calls(&mut pending) {
                                emit(d).await;
                            }
                        }
                    }
                }
            }
        }
        // Stream ended without [DONE]; still flush what we have.
        for d in flush_tool_calls(&mut pending) {
            emit(d).await;
        }
        emit(Ok(ChatDelta::Finished)).await;
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> OpenAiCompatProvider {
        OpenAiCompatProvider::new(ProviderConfig {
            base_url: "https://example.com/v1".to_string(),
            api_key: String::new(),
            model: "thinking-model".to_string(),
        })
    }

    fn request(temperature: Option<f32>) -> CompletionRequest {
        CompletionRequest {
            messages: vec![ChatMessage::user("hello")],
            tools: Vec::new(),
            temperature,
        }
    }

    #[test]
    fn omits_temperature_when_the_caller_uses_provider_defaults() {
        let body = provider().build_body(&request(None));
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn preserves_an_explicit_temperature_for_compatible_models() {
        let body = provider().build_body(&request(Some(0.4)));
        let temperature = body["temperature"].as_f64().unwrap();
        assert!((temperature - 0.4).abs() < 0.000_001);
    }
}

/// Minimal channel-backed stream builder (avoids an async-stream macro dep).
fn async_stream<F, Fut>(f: F) -> impl futures_util::Stream<Item = Result<ChatDelta, ProviderError>>
where
    F: FnOnce(EmitFn) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<ChatDelta, ProviderError>>(64);
    let emit: EmitFn = std::sync::Arc::new(move |item| {
        let tx = tx.clone();
        Box::pin(async move {
            let _ = tx.send(item).await;
        })
    });
    tokio::spawn(f(emit));
    tokio_stream_from_rx(rx)
}

type EmitFn = std::sync::Arc<
    dyn Fn(
            Result<ChatDelta, ProviderError>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

fn tokio_stream_from_rx<T>(
    mut rx: tokio::sync::mpsc::Receiver<T>,
) -> impl futures_util::Stream<Item = T> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}
