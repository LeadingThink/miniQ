//! OpenAI-compatible chat completions adapter with SSE streaming.

use async_trait::async_trait;
use base64::Engine;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::provider::{
    ChatDelta, ChatImage, ChatMessage, ChatRole, CompletionRequest, DeltaStream, ModelProvider,
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

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

fn image_to_json(image: &ChatImage) -> Result<Value, ProviderError> {
    let metadata = std::fs::metadata(&image.path).map_err(|error| {
        ProviderError::Config(format!(
            "cannot read attached image {}: {error}",
            image.path
        ))
    })?;
    if !metadata.is_file() {
        return Err(ProviderError::Config(format!(
            "attached image is not a file: {}",
            image.path
        )));
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(ProviderError::Config(format!(
            "attached image exceeds 20 MB: {}",
            image.path
        )));
    }
    let bytes = std::fs::read(&image.path).map_err(|error| {
        ProviderError::Config(format!(
            "cannot read attached image {}: {error}",
            image.path
        ))
    })?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(json!({
        "type": "image_url",
        "image_url": {
            "url": format!("data:{};base64,{encoded}", image.mime_type),
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
                        return Err(ProviderError::IncompleteToolArguments {
                            tool: c.name,
                            detail: e.to_string(),
                        })
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

fn decode_sse_event(
    event: &str,
    pending: &mut Vec<PendingToolCall>,
    saw_finish_reason: &mut bool,
) -> (Vec<Result<ChatDelta, ProviderError>>, bool) {
    let mut deltas = Vec::new();
    for line in event.lines() {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data == "[DONE]" {
            deltas.extend(flush_tool_calls(pending));
            deltas.push(Ok(ChatDelta::Finished));
            return (deltas, true);
        }
        let parsed: StreamChunk = match serde_json::from_str(data) {
            Ok(parsed) => parsed,
            Err(error) => {
                deltas.push(Err(ProviderError::InvalidResponse(format!(
                    "bad SSE chunk: {error}"
                ))));
                return (deltas, true);
            }
        };
        for choice in parsed.choices {
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
            if let Some(reason) = choice.finish_reason {
                *saw_finish_reason = true;
                match reason.as_str() {
                    "stop" | "tool_calls" | "function_call" => {
                        deltas.extend(flush_tool_calls(pending));
                    }
                    "length" | "max_tokens" => {
                        deltas.push(Err(ProviderError::OutputLimitReached));
                        return (deltas, true);
                    }
                    "content_filter" => {
                        deltas.push(Err(ProviderError::InvalidResponse(
                            "provider blocked the completion with content_filter".to_string(),
                        )));
                        return (deltas, true);
                    }
                    other => {
                        deltas.push(Err(ProviderError::InvalidResponse(format!(
                            "unsupported finish_reason: {other}"
                        ))));
                        return (deltas, true);
                    }
                }
            }
        }
    }
    (deltas, false)
}

async fn forward_sse_event(
    event: &str,
    pending: &mut Vec<PendingToolCall>,
    saw_finish_reason: &mut bool,
    emit: &EmitFn,
) -> bool {
    let (deltas, terminal) = decode_sse_event(event, pending, saw_finish_reason);
    for delta in deltas {
        emit(delta).await;
    }
    terminal
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
        let mut saw_finish_reason = false;

        while let Some(chunk) = byte_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    emit(Err(ProviderError::Http(e))).await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            // Normalize CRLF so compatible gateways using Windows-style SSE
            // framing are parsed identically to LF-only streams.
            if buffer.contains('\r') {
                buffer = buffer.replace("\r\n", "\n");
            }

            // SSE events are separated by a blank line.
            while let Some(pos) = buffer.find("\n\n") {
                let event = buffer[..pos].to_string();
                buffer.drain(..pos + 2);
                if forward_sse_event(&event, &mut pending, &mut saw_finish_reason, &emit).await {
                    return;
                }
            }
        }
        // A final SSE event is legal even without a trailing blank line.
        if !buffer.trim().is_empty()
            && forward_sse_event(&buffer, &mut pending, &mut saw_finish_reason, &emit).await
        {
            return;
        }
        // Some compatible providers omit [DONE] but still send an explicit
        // finish reason. A bare EOF is never a successful completion.
        if saw_finish_reason {
            for d in flush_tool_calls(&mut pending) {
                emit(d).await;
            }
            emit(Ok(ChatDelta::Finished)).await;
        } else {
            emit(Err(ProviderError::IncompleteStream)).await;
        }
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
            max_output_tokens: Some(16_384),
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

    #[test]
    fn includes_the_agent_output_budget() {
        let body = provider().build_body(&request(None));
        assert_eq!(body["max_tokens"], 16_384);
    }

    #[test]
    fn encodes_attached_images_as_openai_vision_content_parts() {
        let path = std::env::temp_dir().join("miniq-openai-image-test.png");
        std::fs::write(&path, [0x89_u8, b'P', b'N', b'G']).unwrap();
        let mut request = request(None);
        request.messages[0].images.push(ChatImage {
            path: path.to_string_lossy().into_owned(),
            mime_type: "image/png".to_string(),
        });
        let body = provider().build_body(&request);
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["detail"], "auto");
        assert!(content[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn done_event_finishes_a_normal_stream() {
        let mut pending = Vec::new();
        let mut saw_finish = false;
        let (deltas, terminal) = decode_sse_event("data: [DONE]", &mut pending, &mut saw_finish);

        assert!(terminal);
        assert_eq!(deltas.len(), 1);
        assert!(matches!(deltas[0], Ok(ChatDelta::Finished)));
    }

    #[test]
    fn output_limit_is_not_reported_as_success() {
        let mut pending = Vec::new();
        let mut saw_finish = false;
        let event =
            r#"data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}"#;
        let (deltas, terminal) = decode_sse_event(event, &mut pending, &mut saw_finish);

        assert!(terminal);
        assert!(saw_finish);
        assert!(matches!(
            &deltas[0],
            Ok(ChatDelta::Text(text)) if text == "partial"
        ));
        assert!(matches!(deltas[1], Err(ProviderError::OutputLimitReached)));
    }

    #[test]
    fn incomplete_tool_json_is_rejected_before_execution() {
        let mut pending = Vec::new();
        let mut saw_finish = false;
        let event = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"file_write","arguments":"{\\\"path\\\":\\\"a"}}]},"finish_reason":"tool_calls"}]}"#;
        let (deltas, terminal) = decode_sse_event(event, &mut pending, &mut saw_finish);

        assert!(!terminal);
        assert!(matches!(
            deltas.as_slice(),
            [Err(ProviderError::IncompleteToolArguments { tool, .. })] if tool == "file_write"
        ));
    }

    #[test]
    fn crlf_event_body_is_parseable_after_transport_normalization() {
        let mut pending = Vec::new();
        let mut saw_finish = false;
        let normalized =
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\r\n"
                .replace("\r\n", "\n");
        let (deltas, terminal) = decode_sse_event(&normalized, &mut pending, &mut saw_finish);

        assert!(!terminal);
        assert!(saw_finish);
        assert!(matches!(
            deltas.as_slice(),
            [Ok(ChatDelta::Text(text))] if text == "ok"
        ));
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
