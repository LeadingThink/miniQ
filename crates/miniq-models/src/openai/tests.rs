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
    let event = r#"data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}"#;
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

#[test]
fn joins_multiline_sse_data_before_decoding_json() {
    let mut pending = Vec::new();
    let mut saw_finish = false;
    let event =
        "data: {\"choices\":[\ndata: {\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}";

    let (deltas, terminal) = decode_sse_event(event, &mut pending, &mut saw_finish);

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

    let (deltas, terminal) = decode_sse_event(event, &mut pending, &mut saw_finish);

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
    );

    assert!(terminal);
    assert!(matches!(
        deltas.as_slice(),
        [Err(ProviderError::InvalidResponse(detail))] if detail.contains("upstream unavailable")
    ));
}

#[test]
fn buffers_split_utf8_until_the_complete_sse_event_arrives() {
    let bytes = "data: {\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}\n\n".as_bytes();
    let split = bytes.iter().position(|byte| *byte >= 0x80).unwrap() + 1;
    let mut buffer = bytes[..split].to_vec();
    assert!(take_sse_event(&mut buffer).is_none());

    buffer.extend_from_slice(&bytes[split..]);
    let event = take_sse_event(&mut buffer).unwrap();
    let decoded = decode_event_bytes(&event).unwrap();

    assert!(decoded.contains("中文"));
    assert!(buffer.is_empty());
}

#[test]
fn recognizes_lf_crlf_and_cr_event_boundaries() {
    for separator in ["\n\n", "\r\n\r\n", "\r\r", "\r\n\n", "\n\r\n"] {
        let mut buffer = format!("data: [DONE]{separator}next").into_bytes();
        assert_eq!(take_sse_event(&mut buffer).unwrap(), b"data: [DONE]");
        assert_eq!(buffer, b"next");
    }
}
