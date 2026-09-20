//! Assert raw HTTP bytes, not just parsed JSON, for each production adapter.

use std::sync::{Arc, Mutex};

use axum::{body::Bytes, http::HeaderMap, routing::post, Router};
use futures_util::TryStreamExt;
use serde_json::{json, Value};

use crate::{
    AnthropicProvider, ApiProtocol, ChatDelta, ChatMessage, CompletionRequest, ModelProvider,
    OpenAiCompatProvider, ProviderConfig, ResponsesProvider, ToolSpec,
};

fn response(protocol: ApiProtocol) -> String {
    let events = match protocol {
        ApiProtocol::Responses => vec![
            json!({"type":"response.output_text.delta","delta":"done"}),
            json!({"type":"response.completed","response":{"id":"test","output":[]}}),
        ],
        ApiProtocol::ChatCompletions => vec![
            json!({"choices":[{"delta":{"content":"done"},"finish_reason":null}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
        ],
        ApiProtocol::AnthropicMessages => vec![
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
            json!({"type":"message_stop"}),
        ],
        ApiProtocol::Auto => unreachable!(),
    };
    events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}

async fn assert_model_first(protocol: ApiProtocol, path: &str, model: &str) {
    let captured = Arc::new(Mutex::new(None));
    let handler_capture = captured.clone();
    let router = Router::new().route(
        path,
        post(move |headers: HeaderMap, bytes: Bytes| async move {
            *handler_capture.lock().unwrap() = Some((headers, bytes));
            ([("content-type", "text/event-stream")], response(protocol))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = ProviderConfig {
        base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
        api_key: "test-key".into(),
        model: model.into(),
        api_protocol: protocol,
        reasoning_effort: None,
    };
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider: Box<dyn ModelProvider> = match protocol {
        ApiProtocol::Responses => Box::new(ResponsesProvider::new(config)),
        ApiProtocol::ChatCompletions => Box::new(OpenAiCompatProvider::new(config)),
        ApiProtocol::AnthropicMessages => Box::new(AnthropicProvider::new(config)),
        ApiProtocol::Auto => unreachable!(),
    };
    let content = "完整的多步任务上下文，包含引号\"、换行\n与反斜线\\。".repeat(4096);
    let request = CompletionRequest {
        trace: Default::default(),
        messages: vec![
            ChatMessage::system("Follow the user's language."),
            ChatMessage::user(&content),
        ],
        tools: vec![ToolSpec {
            name: "read".into(),
            description: "Read a file".into(),
            parameters: json!({"type":"object", "properties":{"path":{"type":"string"}}, "required":["path"]}),
        }],
        temperature: None,
        max_output_tokens: Some(4096),
    };
    let result = provider.stream_complete(request).await;
    let deltas = result.unwrap().try_collect::<Vec<_>>().await.unwrap();
    server.abort();
    assert!(deltas.contains(&ChatDelta::Text("done".into())));
    assert!(deltas.contains(&ChatDelta::Finished));
    let (headers, bytes) = captured.lock().unwrap().take().unwrap();
    assert!(bytes.len() > 65_536);
    assert!(bytes.starts_with(format!("{{\"model\":\"{model}\",").as_bytes()));
    assert_eq!(headers["content-type"], "application/json");
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["model"], model);
    assert_eq!(body["stream"], true);
    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    match protocol {
        ApiProtocol::Responses => {
            assert_eq!(body["input"][1]["content"][0]["text"], content);
            assert_eq!(body["max_output_tokens"], 4096);
        }
        ApiProtocol::ChatCompletions => {
            assert_eq!(body["messages"][1]["content"], content);
            assert_eq!(body["max_tokens"], 4096);
        }
        ApiProtocol::AnthropicMessages => {
            assert_eq!(body["messages"][0]["content"][0]["text"], content);
            assert_eq!(body["max_tokens"], 4096);
            assert_eq!(headers["x-api-key"], "test-key");
            assert_eq!(headers["anthropic-version"], "2023-06-01");
        }
        ApiProtocol::Auto => unreachable!(),
    }
    if protocol != ApiProtocol::AnthropicMessages {
        assert_eq!(headers["authorization"], "Bearer test-key");
    }
}

#[tokio::test]
async fn responses_sends_model_before_large_input() {
    assert_model_first(ApiProtocol::Responses, "/v1/responses", "gpt-test").await;
}

#[tokio::test]
async fn chat_completions_sends_model_first() {
    assert_model_first(
        ApiProtocol::ChatCompletions,
        "/v1/chat/completions",
        "gemini-test",
    )
    .await;
}

#[tokio::test]
async fn anthropic_sends_model_before_messages_and_max_tokens() {
    assert_model_first(
        ApiProtocol::AnthropicMessages,
        "/v1/messages",
        "claude-test",
    )
    .await;
}
