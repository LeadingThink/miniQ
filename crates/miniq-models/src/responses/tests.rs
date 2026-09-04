use super::*;
use crate::{ChatImage, ToolSpec};

fn provider() -> ResponsesProvider {
    ResponsesProvider::new(ProviderConfig {
        base_url: "https://example.test/v1".into(),
        api_key: String::new(),
        model: "gpt-test".into(),
        api_protocol: ApiProtocol::Responses,
    })
}

fn request(messages: Vec<ChatMessage>) -> CompletionRequest {
    CompletionRequest {
        messages,
        tools: vec![ToolSpec {
            name: "file.read".into(),
            description: "Read a file".into(),
            parameters: json!({"type":"object"}),
        }],
        temperature: None,
        max_output_tokens: Some(2048),
    }
}

#[test]
fn builds_native_responses_input_and_tools() {
    let body = provider().build_body(&request(vec![ChatMessage::user("hello")]));
    assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(body["tools"][0]["name"], "file_read");
    assert_eq!(body["max_output_tokens"], 2048);
    assert_eq!(body["include"][0], "reasoning.encrypted_content");
}

#[test]
fn replays_provider_output_and_function_results_losslessly() {
    let mut assistant = ChatMessage::assistant("");
    assistant.provider_context = Some(ProviderContext {
        protocol: ApiProtocol::Responses,
        data: json!([
            {"type":"reasoning","encrypted_content":"opaque"},
            {"type":"function_call","call_id":"call-1","name":"file_read","arguments":"{}"}
        ]),
    });
    let body = provider().build_body(&request(vec![
        assistant,
        ChatMessage::tool_result("call-1", r#"{"ok":true}"#),
    ]));
    assert_eq!(body["input"][0]["type"], "reasoning");
    assert_eq!(body["input"][1]["call_id"], "call-1");
    assert_eq!(body["input"][2]["type"], "function_call_output");
}

#[test]
fn encodes_images_as_responses_input_parts() {
    let path = std::env::temp_dir().join("miniq-responses-image.png");
    std::fs::write(&path, [0x89_u8, b'P', b'N', b'G']).unwrap();
    let mut message = ChatMessage::user("inspect");
    message.images.push(ChatImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png".into(),
    });
    let body = provider().build_body(&request(vec![message]));
    assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
    let _ = std::fs::remove_file(path);
}

fn decode(decoder: &mut ResponsesDecoder, event: Value) -> DecodedEvent {
    decoder.decode(&format!("data: {event}"))
}

#[test]
fn decodes_fragmented_function_calls_and_preserves_output_context() {
    let mut decoder = ResponsesDecoder::default();
    decode(
        &mut decoder,
        json!({
            "type":"response.output_item.added","output_index":0,
            "item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"file_read","arguments":""}
        }),
    );
    decode(
        &mut decoder,
        json!({
            "type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"path\":"
        }),
    );
    decode(
        &mut decoder,
        json!({
            "type":"response.function_call_arguments.delta","output_index":0,"delta":"\"README.md\"}"
        }),
    );
    let done = decode(
        &mut decoder,
        json!({
            "type":"response.output_item.done","output_index":0,
            "item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"file_read","arguments":"{\"path\":\"README.md\"}"}
        }),
    );
    assert!(
        matches!(&done.items[0], Ok(ChatDelta::ToolCall(call)) if call.id == "call-1" && call.arguments["path"] == "README.md")
    );

    let completed = decode(
        &mut decoder,
        json!({
            "type":"response.completed","response":{"output":[
                {"type":"reasoning","encrypted_content":"opaque"},
                {"type":"function_call","id":"fc-1","call_id":"call-1","name":"file_read","arguments":"{\"path\":\"README.md\"}"}
            ]}
        }),
    );
    assert!(completed.terminal);
    assert!(
        matches!(&completed.items[0], Ok(ChatDelta::Context(context)) if context.data[0]["type"] == "reasoning")
    );
    assert!(matches!(completed.items[1], Ok(ChatDelta::Finished)));
}

#[test]
fn maps_incomplete_and_failed_terminal_events_to_errors() {
    let incomplete = decode(
        &mut ResponsesDecoder::default(),
        json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}),
    );
    assert!(matches!(
        incomplete.items[0],
        Err(ProviderError::OutputLimitReached)
    ));

    let failed = decode(
        &mut ResponsesDecoder::default(),
        json!({"type":"response.failed","response":{"error":{"message":"overloaded"}}}),
    );
    assert!(
        matches!(&failed.items[0], Err(ProviderError::InvalidResponse(detail)) if detail.contains("overloaded"))
    );
}
