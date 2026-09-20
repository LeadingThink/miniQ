//! Real provider serialization against a loopback-only HTTP capture server.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{body::Bytes, extract::State, http::header, routing::post, Router};
use miniq_models::{
    AnthropicProvider, ApiProtocol, ChatImage, ChatMessage, ImageDetail, ModelProvider,
    OpenAiCompatProvider, ProviderConfig, ProviderContext, ResponsesProvider, ToolCallRequest,
    ToolSpec,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{run_turn, AgentError, ToolExecutor};

#[derive(Clone)]
struct CaptureState {
    requests: Arc<Mutex<Vec<(usize, Value)>>>,
    responses: Arc<Mutex<VecDeque<String>>>,
}

struct CaptureServer {
    base_url: String,
    state: CaptureState,
    task: tokio::task::JoinHandle<()>,
}

impl CaptureServer {
    async fn start(responses: Vec<String>) -> Self {
        let state = CaptureState {
            requests: Default::default(),
            responses: Arc::new(Mutex::new(responses.into())),
        };
        let router = Router::new()
            .route("/{*path}", post(capture))
            .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            base_url,
            state,
            task,
        }
    }

    fn body(&self, index: usize) -> Value {
        self.state.requests.lock().unwrap()[index].1.clone()
    }
}

impl Drop for CaptureServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn capture(
    State(state): State<CaptureState>,
    bytes: Bytes,
) -> impl axum::response::IntoResponse {
    let body = serde_json::from_slice(&bytes).expect("valid serialized provider request");
    state.requests.lock().unwrap().push((bytes.len(), body));
    let response = state
        .responses
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected request");
    ([(header::CONTENT_TYPE, "text/event-stream")], response)
}

struct Executor {
    tools: Vec<ToolSpec>,
    calls: Mutex<Vec<ToolCallRequest>>,
}

impl Default for Executor {
    fn default() -> Self {
        Self {
            tools: ["view_image", "computer_use"]
                .into_iter()
                .map(|name| ToolSpec {
                    name: name.into(),
                    description: "Wire test tool".into(),
                    parameters: json!({"type":"object","additionalProperties":true}),
                })
                .collect(),
            calls: Default::default(),
        }
    }
}

#[async_trait]
impl ToolExecutor for Executor {
    fn specs(&self) -> Vec<ToolSpec> {
        self.tools.clone()
    }

    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        self.calls.lock().unwrap().push(call.clone());
        Ok(json!({"test_only":true,"executed_on_computer":false}))
    }
}

fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}

fn final_response(protocol: ApiProtocol) -> String {
    match protocol {
        ApiProtocol::Responses => sse(&[
            json!({"type":"response.output_text.delta","delta":"done"}),
            json!({"type":"response.completed","response":{"id":"test-response","output":[]}}),
        ]),
        ApiProtocol::ChatCompletions => sse(&[
            json!({"choices":[{"delta":{"content":"done"},"finish_reason":null}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
        ]),
        ApiProtocol::AnthropicMessages => sse(&[
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
            json!({"type":"message_stop"}),
        ]),
        ApiProtocol::Auto => unreachable!(),
    }
}

fn provider(protocol: ApiProtocol, base_url: &str) -> Box<dyn ModelProvider> {
    let config = ProviderConfig {
        base_url: base_url.into(),
        api_key: String::new(),
        model: match protocol {
            ApiProtocol::Responses => "gpt-wire-test",
            ApiProtocol::ChatCompletions => "gemini-wire-test",
            ApiProtocol::AnthropicMessages => "claude-wire-test",
            ApiProtocol::Auto => unreachable!(),
        }
        .into(),
        api_protocol: protocol,
        reasoning_effort: None,
    };
    match protocol {
        ApiProtocol::Responses => Box::new(ResponsesProvider::new(config)),
        ApiProtocol::ChatCompletions => Box::new(OpenAiCompatProvider::new(config)),
        ApiProtocol::AnthropicMessages => Box::new(AnthropicProvider::new(config)),
        ApiProtocol::Auto => unreachable!(),
    }
}

fn history(directory: &std::path::Path, protocol: ApiProtocol) -> Vec<ChatMessage> {
    let mut messages = vec![
        ChatMessage::system("test"),
        ChatMessage::user("compare the images"),
    ];
    for index in 1..=4 {
        let id = format!("call-{index}");
        let name = if protocol == ApiProtocol::Responses {
            "computer_use"
        } else {
            "view_image"
        };
        let arguments = json!({"action":"screenshot"});
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls.push(ToolCallRequest {
            id: id.clone(),
            name: name.into(),
            arguments: arguments.clone(),
        });
        assistant.provider_context = Some(ProviderContext {
            protocol,
            data: match protocol {
                ApiProtocol::Responses => json!([
                    {"type":"reasoning","id":format!("reason-{index}"),"encrypted_content":format!("opaque-{index}")},
                    {"type":"computer_call","id":format!("native-{index}"),"call_id":id,"action":{"type":"screenshot"}}
                ]),
                ApiProtocol::ChatCompletions => json!({
                    "reasoning_content":format!("reason-{index}"),
                    "tool_extras":{id.clone():{"google":{"thought_signature":format!("signature-{index}")}}}
                }),
                ApiProtocol::AnthropicMessages => json!([
                    {"type":"thinking","thinking":format!("reason-{index}"),"signature":format!("signature-{index}")},
                    {"type":"tool_use","id":id,"name":name,"input":arguments}
                ]),
                ApiProtocol::Auto => unreachable!(),
            },
        });
        let mut output = ChatMessage::tool_result(
            id,
            json!({
                "observationId":format!("observation-{index}"),
                "screenshot":{"id":format!("observation-{index}")}
            })
            .to_string(),
        );
        let path = directory.join(format!("image-{index}.png"));
        // The High path sends original bytes; these trusted bytes need no decoder.
        std::fs::write(&path, [0x89_u8, b'P', b'N', b'G', index as u8]).unwrap();
        output.images.push(ChatImage {
            path: path.to_string_lossy().into(),
            mime_type: "image/png".into(),
            detail: ImageDetail::High,
        });
        messages.extend([assistant, output]);
    }
    messages
}

fn image_count(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(image_count).sum(),
        Value::Object(object) => {
            let pixel = matches!(
                value["type"].as_str(),
                Some("input_image" | "image_url" | "computer_screenshot")
            ) || (value["type"] == "image" && value["source"]["type"] == "base64");
            usize::from(pixel) + object.values().map(image_count).sum::<usize>()
        }
        _ => 0,
    }
}

fn assert_wire_archive(body: &Value, protocol: ApiProtocol) {
    assert_eq!(image_count(body), 2);
    let serialized = body.to_string();
    assert!(!serialized.contains("image_archive"));
    assert!(!serialized.contains("source_content"));
    for index in 1..=4 {
        assert!(serialized.contains(&format!("img_{index}")));
    }
    let tool = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| match protocol {
            ApiProtocol::ChatCompletions => tool["function"]["name"] == "image_history",
            _ => tool["name"] == "image_history",
        })
        .unwrap();
    let schema = match protocol {
        ApiProtocol::Responses => &tool["parameters"],
        ApiProtocol::ChatCompletions => &tool["function"]["parameters"],
        ApiProtocol::AnthropicMessages => &tool["input_schema"],
        ApiProtocol::Auto => unreachable!(),
    };
    assert_eq!(schema["type"], "object");
    for action in ["list", "read", "sources"] {
        assert!(schema.to_string().contains(&format!("\"{action}\"")));
    }
    if protocol != ApiProtocol::Responses {
        let actions = schema["properties"]["action"]["enum"].as_array().unwrap();
        assert_eq!(actions.len(), 3);
        for action in ["list", "read", "sources"] {
            assert!(actions.contains(&json!(action)));
        }
    }
}

async fn run(protocol: ApiProtocol) -> Value {
    let server = CaptureServer::start(vec![final_response(protocol)]).await;
    let directory = tempfile::tempdir().unwrap();
    let original = history(directory.path(), protocol);
    let expected = serde_json::to_value(&original).unwrap();
    let (events, _receiver) = tokio::sync::mpsc::channel(128);
    let result = run_turn(
        provider(protocol, &server.base_url).as_ref(),
        &Executor::default(),
        original.clone(),
        events,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.final_text, "done");
    assert_eq!(serde_json::to_value(&original).unwrap(), expected);
    assert_eq!(
        result
            .provider_history
            .iter()
            .map(|message| message.images.len())
            .sum::<usize>(),
        4
    );
    let body = server.body(0);
    assert_wire_archive(&body, protocol);
    body
}

#[tokio::test]
async fn chat_gemini_wire_retires_pixels_without_losing_thought_signatures() {
    let body = run(ApiProtocol::ChatCompletions).await;
    let assistants = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "assistant")
        .collect::<Vec<_>>();
    for (index, assistant) in assistants.iter().enumerate() {
        assert_eq!(
            assistant["reasoning_content"],
            format!("reason-{}", index + 1)
        );
        assert_eq!(
            assistant["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
            format!("signature-{}", index + 1)
        );
    }
    assert_eq!(assistants.len(), 4);
}

#[tokio::test]
async fn anthropic_wire_preserves_signed_thinking_and_all_archive_actions() {
    let body = run(ApiProtocol::AnthropicMessages).await;
    let assistants = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "assistant")
        .collect::<Vec<_>>();
    for (index, assistant) in assistants.iter().enumerate() {
        assert_eq!(assistant["content"][0]["type"], "thinking");
        assert_eq!(
            assistant["content"][0]["signature"],
            format!("signature-{}", index + 1)
        );
        assert_eq!(assistant["content"][1]["id"], format!("call-{}", index + 1));
    }
    assert_eq!(assistants.len(), 4);
}

#[tokio::test]
async fn responses_wire_keeps_valid_native_pairs_and_binds_only_the_latest_screenshot() {
    let tool_reply = sse(&[json!({"type":"response.completed","response":{"output":[{
        "type":"computer_call","id":"next-native","call_id":"next-call",
        "action":{"type":"click","x":2,"y":3},"pending_safety_checks":[]
    }]}})]);
    let protocol = ApiProtocol::Responses;
    let server = CaptureServer::start(vec![tool_reply, final_response(protocol)]).await;
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::default();
    let (events, _receiver) = tokio::sync::mpsc::channel(128);
    let result = run_turn(
        provider(protocol, &server.base_url).as_ref(),
        &executor,
        history(directory.path(), protocol),
        events,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.final_text, "done");
    let body = server.body(0);
    assert_wire_archive(&body, protocol);
    let input = body["input"].as_array().unwrap();
    for index in 1..=4 {
        let id = format!("call-{index}");
        let pair = input
            .iter()
            .filter(|item| item["call_id"] == id)
            .collect::<Vec<_>>();
        assert_eq!(pair.len(), 2);
        assert_eq!(
            pair[0]["type"],
            if index <= 2 {
                "function_call"
            } else {
                "computer_call"
            }
        );
        assert_eq!(
            pair[1]["type"],
            if index <= 2 {
                "function_call_output"
            } else {
                "computer_call_output"
            }
        );
    }
    assert_eq!(
        input
            .iter()
            .filter(|item| item["type"] == "reasoning")
            .count(),
        4
    );
    let calls = executor.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].arguments["observationId"], "observation-4");
}

#[tokio::test]
#[ignore = "requires an explicitly supplied private replay directory; all HTTP stays on loopback"]
async fn measure_private_history_wire_bytes_without_sending_to_a_model() {
    use futures_util::StreamExt;
    use miniq_models::CompletionRequest;
    let directory = std::path::PathBuf::from(
        std::env::var("MINIQ_VISUAL_REPLAY_DIR").expect("set private fixture directory"),
    );
    let messages: Vec<ChatMessage> =
        serde_json::from_slice(&std::fs::read(directory.join("messages.json")).unwrap()).unwrap();
    let tools: Vec<ToolSpec> =
        serde_json::from_slice(&std::fs::read(directory.join("tools.json")).unwrap()).unwrap();
    let executor = Executor {
        tools,
        calls: Default::default(),
    };
    let projected = crate::image_history_tool::ImageHistoryExecutor::new(&executor, &messages);
    let protocol = ApiProtocol::Responses;
    let server =
        CaptureServer::start(vec![final_response(protocol), final_response(protocol)]).await;
    let provider = provider(protocol, &server.base_url);
    for (messages, tools) in [
        (messages.clone(), executor.specs()),
        (projected.messages(&messages), projected.specs()),
    ] {
        let mut stream = provider
            .stream_complete(CompletionRequest {
                trace: Default::default(),
                messages,
                tools,
                temperature: None,
                max_output_tokens: None,
            })
            .await
            .unwrap();
        while let Some(event) = stream.next().await {
            event.unwrap();
        }
    }
    let requests = server.state.requests.lock().unwrap();
    println!(
        "{}",
        json!({"beforeBytes":requests[0].0,"afterBytes":requests[1].0,"beforeImages":image_count(&requests[0].1),"afterImages":image_count(&requests[1].1)})
    );
    assert!(requests[1].0 < requests[0].0);
}
