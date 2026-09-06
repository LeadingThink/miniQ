use super::*;
use crate::{ApiProtocol, ToolSpec};

#[test]
fn reasoning_and_tool_signatures_survive_streaming_and_replay() {
    let mut decoder = ChatCompletionsDecoder::default();
    decoder.decode(r#"data: {"choices":[{"delta":{"reasoning_content":"first "}}]}"#);
    decoder.decode(r#"data: {"choices":[{"delta":{"reasoning_content":"second","tool_calls":[{"index":0,"id":"call-1","function":{"name":"file_read","arguments":"{}"},"extra_content":{"google":{"thought_signature":"opaque-signature"}}}]}}]}"#);
    let decoded =
        decoder.decode(r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#);
    let mut assistant = ChatMessage::assistant("");
    for delta in decoded.items {
        match delta.unwrap() {
            ChatDelta::Context(context) => assistant.provider_context = Some(context),
            ChatDelta::ToolCall(call) => assistant.tool_calls.push(call),
            _ => {}
        }
    }
    let replay = message_to_json(&assistant).unwrap();
    assert_eq!(replay["reasoning_content"], "first second");
    assert_eq!(
        replay["tool_calls"][0]["extra_content"]["google"]["thought_signature"],
        "opaque-signature"
    );
    assistant.tool_calls.clear();
    assert_eq!(
        message_to_json(&assistant).unwrap()["reasoning_content"],
        "first second"
    );
    assistant.provider_context.as_mut().unwrap().protocol = ApiProtocol::AnthropicMessages;
    assert!(message_to_json(&assistant)
        .unwrap()
        .get("reasoning_content")
        .is_none());
}

#[test]
fn explicit_effort_is_encoded_on_the_actual_chat_request() {
    let mut provider = provider();
    provider.config.reasoning_effort = Some(miniq_protocol::ReasoningEffort::High);
    let mut completion = request(None);
    completion.max_output_tokens = None;
    let wire = provider.build_body(&completion);
    assert_eq!(wire["reasoning_effort"], "high");
    assert!(wire.get("max_tokens").is_none());
}

fn provider() -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(ProviderConfig {
        base_url: "https://example.com/v1".to_string(),
        api_key: String::new(),
        model: "thinking-model".to_string(),
        api_protocol: ApiProtocol::ChatCompletions,
        reasoning_effort: None,
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
fn omits_output_limit_when_the_caller_uses_provider_defaults() {
    let mut completion = request(None);
    completion.max_output_tokens = None;
    let body = provider().build_body(&completion);
    assert!(body.get("max_tokens").is_none());
}

#[test]
fn normalizes_compat_tool_schemas_and_reserved_names() {
    let mut completion = request(None);
    completion.tools = vec![ToolSpec {
        name: "web_search".into(),
        description: "Search the web".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "source": {
                    "oneOf": [
                        {"type":"string","const":"web"},
                        {"type":"string","const":"news"}
                    ]
                }
            }
        }),
    }];

    let body = provider().build_body(&completion);
    let function = &body["tools"][0]["function"];
    assert_eq!(function["name"], "search_web");
    assert!(function["parameters"]["properties"]["source"]
        .get("oneOf")
        .is_none());
    assert_eq!(
        function["parameters"]["properties"]["source"]["enum"],
        json!(["web", "news"])
    );
}

#[test]
fn replays_tool_calls_with_the_same_wire_name_as_the_declaration() {
    let mut assistant = ChatMessage::assistant("");
    assistant.tool_calls.push(ToolCallRequest {
        id: "call-1".into(),
        name: "web_search".into(),
        arguments: json!({"query":"miniQ"}),
    });

    let mut completion = request(None);
    completion.messages = vec![assistant];
    let body = provider().build_body(&completion);
    assert_eq!(
        body["messages"][0]["tool_calls"][0]["function"]["name"],
        "search_web"
    );
}

#[test]
fn encodes_attached_images_as_openai_vision_content_parts() {
    let path = std::env::temp_dir().join("miniq-openai-image-test.png");
    std::fs::write(&path, [0x89_u8, b'P', b'N', b'G']).unwrap();
    let mut request = request(None);
    request.messages[0].images.push(ChatImage {
        detail: crate::ImageDetail::Auto,
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
fn tool_observations_follow_the_complete_tool_batch_as_user_images() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.png");
    std::fs::write(&path, [0x89_u8, b'P', b'N', b'G']).unwrap();
    let mut first = ChatMessage::tool_result("call-1", "observation metadata");
    first.images.push(ChatImage {
        path: path.to_string_lossy().into(),
        mime_type: "image/png".into(),
        detail: crate::ImageDetail::High,
    });
    let second = ChatMessage::tool_result("call-2", "other output");
    let encoded = messages_to_json(&[first, second, ChatMessage::assistant("verified")]).unwrap();
    assert_eq!(
        encoded
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tool", "tool", "user", "assistant"]
    );
    assert_eq!(encoded[0]["content"], "observation metadata");
    assert_eq!(encoded[1]["tool_call_id"], "call-2");
    assert!(encoded[2]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("call-1"));
    assert_eq!(encoded[2]["content"][1]["image_url"]["detail"], "high");
}

#[test]
fn done_event_finishes_a_normal_stream() {
    let mut pending = Vec::new();
    let mut saw_finish = false;
    let (deltas, terminal) = decode_sse_event(
        "data: [DONE]",
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

    assert!(terminal);
    assert_eq!(deltas.len(), 1);
    assert!(matches!(deltas[0], Ok(ChatDelta::Finished)));
}

#[test]
fn output_limit_is_not_reported_as_success() {
    let mut pending = Vec::new();
    let mut saw_finish = false;
    let event = r#"data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}"#;
    let (deltas, terminal) = decode_sse_event(
        event,
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

    assert!(terminal);
    assert!(saw_finish);
    assert!(matches!(
        &deltas[0],
        Ok(ChatDelta::Text(text)) if text == "partial"
    ));
    assert!(matches!(
        deltas[1],
        Err(ProviderError::OutputLimitReached(_))
    ));
}

#[test]
fn incomplete_tool_json_is_rejected_before_execution() {
    let mut pending = Vec::new();
    let mut saw_finish = false;
    let event = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"file_write","arguments":"{\\\"path\\\":\\\"a"}}]},"finish_reason":"tool_calls"}]}"#;
    let (deltas, terminal) = decode_sse_event(
        event,
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

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
    let (deltas, terminal) = decode_sse_event(
        &normalized,
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

    assert!(!terminal);
    assert!(saw_finish);
    assert!(matches!(
        deltas.as_slice(),
        [Ok(ChatDelta::Text(text))] if text == "ok"
    ));
}

#[test]
fn joins_multiline_sse_data_before_decoding_json() {
    let mut pending = Vec::new();
    let mut saw_finish = false;
    let event =
        "data: {\"choices\":[\ndata: {\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}";

    let (deltas, terminal) = decode_sse_event(
        event,
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

    assert!(!terminal);
    assert!(saw_finish);
    assert!(matches!(
        deltas.as_slice(),
        [Ok(ChatDelta::Text(text))] if text == "ok"
    ));
}

#[test]
fn accepts_legacy_function_call_deltas() {
    let mut pending = Vec::new();
    let mut saw_finish = false;
    let event = r#"data: {"choices":[{"delta":{"function_call":{"name":"file_read","arguments":"{\"path\":\"README.md\"}"}},"finish_reason":"function_call"}]}"#;

    let (deltas, terminal) = decode_sse_event(
        event,
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

    assert!(!terminal);
    assert!(matches!(
        deltas.as_slice(),
        [Ok(ChatDelta::ToolCall(call))]
            if call.name == "file_read"
                && call.arguments == json!({"path": "README.md"})
                && call.id.starts_with("miniq-call-")
    ));
}

#[test]
fn rejects_a_tool_call_without_a_function_name() {
    let mut pending = vec![PendingToolCall {
        id: "call-1".into(),
        name: String::new(),
        arguments: "{}".into(),
    }];

    let deltas = flush_tool_calls(&mut pending);

    assert!(matches!(
        deltas.as_slice(),
        [Err(ProviderError::InvalidResponse(detail))] if detail.contains("missing a function name")
    ));
}

#[test]
fn surfaces_error_objects_inside_successful_sse_responses() {
    let mut pending = Vec::new();
    let mut saw_finish = false;

    let (deltas, terminal) = decode_sse_event(
        r#"data: {"error":{"message":"upstream unavailable"}}"#,
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

    assert!(terminal);
    assert!(matches!(
        deltas.as_slice(),
        [Err(ProviderError::InvalidResponse(detail))] if detail.contains("upstream unavailable")
    ));
}

#[test]
fn classifies_context_overflow_inside_a_successful_sse_response() {
    let mut pending = Vec::new();
    let mut saw_finish = false;

    let (deltas, terminal) = decode_sse_event(
        r#"data: {"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}"#,
        &mut pending,
        &mut saw_finish,
        &mut Default::default(),
    );

    assert!(terminal);
    assert!(matches!(
        deltas.as_slice(),
        [Err(ProviderError::ContextWindowExceeded)]
    ));
}
