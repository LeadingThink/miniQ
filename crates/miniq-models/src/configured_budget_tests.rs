//! Verify resolved budgets at the HTTP boundary and in model diagnostics.

use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode, Uri},
    routing::{get, post},
    Json, Router,
};
use futures_util::TryStreamExt;
use serde_json::{json, Value};

use crate::{
    ApiProtocol, ChatDelta, ChatMessage, CompletionRequest, ConfiguredProvider, ModelProvider,
    ProviderConfig,
};

#[derive(Default)]
struct Requests {
    metadata: Vec<(String, HeaderMap)>,
    completion: Vec<(String, Bytes)>,
}

struct Fixture {
    provider: ConfiguredProvider,
    requests: Arc<Mutex<Requests>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new(protocol: ApiProtocol, status: StatusCode, metadata: Value) -> Self {
        let requests = Arc::new(Mutex::new(Requests::default()));
        let metadata_requests = requests.clone();
        let completion_requests = requests.clone();
        let app = Router::new()
            .route(
                "/v1/models/{model}",
                get(move |uri: Uri, headers: HeaderMap| {
                    let metadata = metadata.clone();
                    metadata_requests.lock().unwrap().metadata.push((uri.path().into(), headers));
                    async move { (status, Json(metadata)) }
                }),
            )
            .fallback(post(move |uri: Uri, bytes: Bytes| {
                let path = uri.path().to_owned();
                completion_requests.lock().unwrap().completion.push((path.clone(), bytes));
                async move {
                    let events = match path.as_str() {
                        "/v1/messages" => vec![
                            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"done"}}),
                            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                            json!({"type":"message_stop"}),
                        ],
                        "/v1/responses" => vec![
                            json!({"type":"response.output_text.delta","delta":"done"}),
                            json!({"type":"response.completed","response":{"output":[]}}),
                        ],
                        "/v1/chat/completions" => vec![
                            json!({"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}),
                        ],
                        _ => panic!("unexpected completion path {path}"),
                    };
                    let response: String = events.iter().map(|event| format!("data: {event}\n\n")).collect();
                    ([("content-type", "text/event-stream")], response)
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = ConfiguredProvider::new(ProviderConfig {
            base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
            api_key: "fixture-key".into(),
            model: "claude-fable-5-1".into(),
            api_protocol: protocol,
            reasoning_effort: None,
        });
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            provider,
            requests,
            server,
        }
    }

    async fn assert_budget(
        &self,
        requested: Option<u32>,
        expected: Option<u32>,
        protocol: ApiProtocol,
    ) {
        // Exercise streaming before diagnostics too: the fix must not depend
        // on ObservedProvider first asking execution_info to load metadata.
        let deltas = self
            .provider
            .stream_complete(CompletionRequest {
                trace: Default::default(),
                messages: vec![ChatMessage::user("中文问题，保留全文。")],
                tools: Vec::new(),
                temperature: None,
                max_output_tokens: requested,
            })
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert!(deltas.contains(&ChatDelta::Text("done".into())));
        assert!(deltas.contains(&ChatDelta::Finished));
        let info = self
            .provider
            .execution_info(requested)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(info.api_protocol, protocol);
        assert_eq!(info.max_output_tokens, expected);
        let requests = self.requests.lock().unwrap();
        let (path, bytes) = requests.completion.last().unwrap();
        let (expected_path, limit_key) = match protocol {
            ApiProtocol::AnthropicMessages => ("/v1/messages", "max_tokens"),
            ApiProtocol::ChatCompletions => ("/v1/chat/completions", "max_tokens"),
            ApiProtocol::Responses => ("/v1/responses", "max_output_tokens"),
            ApiProtocol::Auto => unreachable!(),
        };
        assert_eq!(path, expected_path);
        assert!(bytes.starts_with(b"{\"model\":\"claude-fable-5-1\","));
        let body: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(
            body.get(limit_key),
            expected.map(|value| json!(value)).as_ref()
        );
        assert_eq!(body["stream"], true);
        assert!(body.get("thinking").is_none());
        assert!(body.get("output_config").is_none());
        if expected.is_none() {
            for key in ["max_tokens", "max_output_tokens", "max_completion_tokens"] {
                assert!(body.get(key).is_none(), "unexpected {key}: {body}");
            }
        }
    }
}

fn metadata(protocol: &str) -> Value {
    json!({"data":{"preferred_api_protocol":protocol, "max_tokens":1_000_000, "max_output":"128000"}})
}

#[tokio::test]
async fn anthropic_uses_advertised_budget_in_wire_and_diagnostics_for_auto_and_explicit_protocol() {
    for protocol in [ApiProtocol::Auto, ApiProtocol::AnthropicMessages] {
        let fixture = Fixture::new(protocol, StatusCode::OK, metadata("anthropic_messages")).await;
        fixture
            .assert_budget(None, Some(128_000), ApiProtocol::AnthropicMessages)
            .await;
        fixture
            .assert_budget(None, Some(128_000), ApiProtocol::AnthropicMessages)
            .await;
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.metadata.len(), 1);
        assert_eq!(requests.metadata[0].0, "/v1/models/claude-fable-5-1");
        assert_eq!(
            requests.metadata[0].1["authorization"],
            "Bearer fixture-key"
        );
    }
}

#[tokio::test]
async fn anthropic_explicit_budget_overrides_advertised_default_without_poisoning_next_request() {
    let fixture = Fixture::new(
        ApiProtocol::Auto,
        StatusCode::OK,
        metadata("anthropic_messages"),
    )
    .await;
    fixture
        .assert_budget(Some(4_096), Some(4_096), ApiProtocol::AnthropicMessages)
        .await;
    fixture
        .assert_budget(None, Some(128_000), ApiProtocol::AnthropicMessages)
        .await;
}

#[tokio::test]
async fn anthropic_unknown_budget_keeps_16384_and_does_not_treat_context_window_as_output() {
    for (status, metadata) in [
        (StatusCode::NOT_FOUND, json!({"error":"unknown model"})),
        (StatusCode::OK, json!({"data":{"max_tokens":1_000_000}})),
        (StatusCode::OK, json!({"data":{"max_output":0}})),
    ] {
        let fixture = Fixture::new(ApiProtocol::Auto, status, metadata).await;
        fixture
            .assert_budget(None, Some(16_384), ApiProtocol::AnthropicMessages)
            .await;
    }
}

#[tokio::test]
async fn chat_and_responses_keep_provider_defaults_despite_advertised_output_budget() {
    for (protocol, name) in [
        (ApiProtocol::ChatCompletions, "chat_completions"),
        (ApiProtocol::Responses, "responses"),
    ] {
        let fixture = Fixture::new(ApiProtocol::Auto, StatusCode::OK, metadata(name)).await;
        assert_eq!(
            fixture.provider.capabilities().await.max_output_tokens,
            Some(128_000)
        );
        fixture.assert_budget(None, None, protocol).await;
        fixture
            .assert_budget(Some(4_096), Some(4_096), protocol)
            .await;
        fixture.assert_budget(None, None, protocol).await;
    }
}
