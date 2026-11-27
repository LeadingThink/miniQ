//! Exercise production tool catalogs through the actual Chat Completions wire
//! adapter in both desktop and headless builds, without controlling any UI.

use std::sync::{Arc, Mutex};

use axum::{routing::post, Json, Router};
use futures_util::TryStreamExt;
use miniq_models::{
    ApiProtocol, ChatDelta, ChatMessage, CompletionRequest, ModelProvider, OpenAiCompatProvider,
    ProviderConfig, ProviderError, ToolSpec,
};
use serde_json::{json, Value};

#[tokio::test]
async fn gemini4_preserves_platform_catalog_and_numeric_tool_arguments() {
    let router = miniq_tools::default_router();
    let mut tools = router.specs();
    let speech = tools
        .iter_mut()
        .find(|tool| tool.name == "synthesize_speech")
        .unwrap();
    // A live channel can constrain an otherwise numeric speed to exactly 1.
    speech.parameters["properties"]["speed"]["enum"] = json!([1, null]);
    let original_speed = speech.parameters["properties"]["speed"].clone();
    let names = tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "browser_automation"));
    for tool in ["computer_use", "app_automation"] {
        assert_eq!(
            names.iter().any(|name| name == tool),
            cfg!(feature = "desktop")
        );
    }

    let fixture = Fixture::start().await;
    let deltas = fixture
        .provider
        .stream_complete(request(tools))
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    let call = deltas
        .iter()
        .find_map(|delta| match delta {
            ChatDelta::ToolCall(call) => Some(call),
            _ => None,
        })
        .unwrap();
    assert_eq!(call.name, "synthesize_speech");
    assert_eq!(call.arguments, json!({"input":"hello","speed":1}));

    let body = fixture.captured.lock().unwrap().take().unwrap();
    let declarations = body["tools"].as_array().unwrap();
    assert_eq!(declarations.len(), names.len());
    for name in &names {
        let wire_name = if name == "web_search" {
            "search_web"
        } else {
            name.as_str()
        };
        assert!(declarations
            .iter()
            .any(|tool| tool["function"]["name"] == wire_name));
    }
    let speech = declarations
        .iter()
        .find(|tool| tool["function"]["name"] == "synthesize_speech")
        .unwrap();
    let speed = &speech["function"]["parameters"]["properties"]["speed"];
    assert_eq!(speed["type"], original_speed["type"]);
    assert_eq!(speed["default"], original_speed["default"]);
    assert!(speed.get("enum").is_none());
    assert!(speed["description"].as_str().unwrap().contains("[1,null]"));
    assert_string_enums(&body["tools"]);
    assert_eq!(
        router
            .specs()
            .iter()
            .find(|tool| tool.name == "synthesize_speech")
            .unwrap()
            .parameters["properties"]["speed"]["type"],
        original_speed["type"]
    );
}

#[tokio::test]
async fn gemini_rejects_invalid_enum_before_sending_http_request() {
    let fixture = Fixture::start().await;
    let tools = vec![ToolSpec {
        name: "invalid_tool".into(),
        description: "Invalid channel schema".into(),
        parameters: json!({"type":"object","properties":{
            "speed":{"type":"string","enum":[1]}
        }}),
    }];
    let error = match fixture.provider.stream_complete(request(tools)).await {
        Ok(_) => panic!("invalid schema must fail before HTTP"),
        Err(error) => error,
    };
    assert!(matches!(error, ProviderError::Config(_)));
    let message = error.to_string();
    assert!(message.contains("invalid_tool"), "{message}");
    assert!(message.contains("/properties/speed/enum/0"), "{message}");
    assert!(fixture.captured.lock().unwrap().is_none());
}

fn request(tools: Vec<ToolSpec>) -> CompletionRequest {
    CompletionRequest {
        context_compact_threshold: None,
        trace: Default::default(),
        messages: vec![ChatMessage::user("Use numeric speed 1")],
        tools,
        temperature: None,
        max_output_tokens: None,
    }
}

struct Fixture {
    provider: OpenAiCompatProvider,
    captured: Arc<Mutex<Option<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn start() -> Self {
        let captured = Arc::new(Mutex::new(None));
        let capture = captured.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |Json(body): Json<Value>| {
                *capture.lock().unwrap() = Some(body);
                async {
                    let arguments = json!({"input":"hello","speed":1}).to_string();
                    let delta = json!({"choices":[{"delta":{"tool_calls":[{
                        "index":0,"id":"call-1",
                        "function":{"name":"synthesize_speech","arguments":arguments}
                    }]}}]});
                    let finish = json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]});
                    (
                        [("content-type", "text/event-stream")],
                        format!("data: {delta}\n\ndata: {finish}\n\ndata: [DONE]\n\n"),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = OpenAiCompatProvider::new(ProviderConfig {
            base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
            api_key: "fixture-key".into(),
            model: "gemini-4-hydrogen".into(),
            api_protocol: ApiProtocol::ChatCompletions,
            reasoning_effort: None,
        });
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            provider,
            captured,
            server,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn assert_string_enums(value: &Value) {
    match value {
        Value::Object(object) => {
            if let Some(choices) = object.get("enum").and_then(Value::as_array) {
                assert!(choices.iter().all(Value::is_string), "{value}");
            }
            for child in object.values() {
                assert_string_enums(child);
            }
        }
        Value::Array(values) => values.iter().for_each(assert_string_enums),
        _ => {}
    }
}
