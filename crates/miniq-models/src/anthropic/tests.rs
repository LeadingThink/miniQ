use super::*;
use crate::{ChatImage, ToolSpec};

fn provider() -> AnthropicProvider {
    AnthropicProvider::new(ProviderConfig {
        base_url: "https://example.test/v1".into(),
        api_key: String::new(),
        model: "claude-test".into(),
        api_protocol: ApiProtocol::AnthropicMessages,
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
        max_output_tokens: Some(4096),
    }
}

#[test]
fn builds_messages_system_tools_and_grouped_tool_results() {
    let body = provider().build_body(&request(vec![
        ChatMessage::system("system"),
        ChatMessage::user("hello"),
        ChatMessage::tool_result("call-1", "one"),
        ChatMessage::tool_result("call-2", "two"),
    ]));
    assert_eq!(body["system"], "system");
    assert_eq!(body["tools"][0]["name"], "file_read");
    assert_eq!(body["messages"][0]["content"].as_array().unwrap().len(), 3);
    assert_eq!(body["messages"][0]["content"][1]["tool_use_id"], "call-1");
}

#[test]
fn replays_signed_thinking_blocks_without_modification() {
    let context = json!([
        {"type":"thinking","thinking":"private","signature":"signed"},
        {"type":"tool_use","id":"call-1","name":"file_read","input":{"path":"README.md"}}
    ]);
    let mut assistant = ChatMessage::assistant("");
    assistant.provider_context = Some(ProviderContext {
        protocol: ApiProtocol::AnthropicMessages,
        data: context.clone(),
    });
    let body = provider().build_body(&request(vec![assistant]));
    assert_eq!(body["messages"][0]["content"], context);
}

#[test]
fn encodes_images_as_anthropic_source_blocks() {
    let path = std::env::temp_dir().join("miniq-anthropic-image.png");
    std::fs::write(&path, [0x89_u8, b'P', b'N', b'G']).unwrap();
    let mut message = ChatMessage::user("inspect");
    message.images.push(ChatImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png".into(),
    });
    let body = provider().build_body(&request(vec![message]));
    assert_eq!(
        body["messages"][0]["content"][1]["source"]["type"],
        "base64"
    );
    let _ = std::fs::remove_file(path);
}

fn decode(decoder: &mut AnthropicDecoder, event: Value) -> DecodedEvent {
    decoder.decode(&format!("data: {event}"))
}

#[test]
fn decodes_text_tool_json_and_signed_thinking() {
    let mut decoder = AnthropicDecoder::default();
    decode(
        &mut decoder,
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
    );
    decode(
        &mut decoder,
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}),
    );
    decode(
        &mut decoder,
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}),
    );
    decode(
        &mut decoder,
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"file_read","input":{}}}),
    );
    decode(
        &mut decoder,
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}),
    );
    decode(
        &mut decoder,
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"README.md\"}"}}),
    );
    let tool = decode(&mut decoder, json!({"type":"content_block_stop","index":1}));
    assert!(
        matches!(&tool.items[0], Ok(ChatDelta::ToolCall(call)) if call.id == "call-1" && call.arguments["path"] == "README.md")
    );

    let done = decode(&mut decoder, json!({"type":"message_stop"}));
    assert!(
        matches!(&done.items[0], Ok(ChatDelta::Context(context)) if context.data[0]["signature"] == "signed")
    );
    assert!(matches!(done.items[1], Ok(ChatDelta::Finished)));
}

#[test]
fn surfaces_anthropic_errors_and_output_limits() {
    let error = decode(
        &mut AnthropicDecoder::default(),
        json!({"type":"error","error":{"type":"overloaded_error","message":"busy"}}),
    );
    assert!(
        matches!(&error.items[0], Err(ProviderError::InvalidResponse(detail)) if detail.contains("busy"))
    );

    let limit = decode(
        &mut AnthropicDecoder::default(),
        json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"}}),
    );
    assert!(matches!(
        limit.items[0],
        Err(ProviderError::OutputLimitReached)
    ));
}

#[test]
fn preserves_streamed_citations_in_provider_context() {
    let mut decoder = AnthropicDecoder::default();
    decode(
        &mut decoder,
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"source"}}),
    );
    decode(
        &mut decoder,
        json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{
                "type":"citations_delta",
                "citation":{"type":"web_search_result_location","url":"https://example.test"}
            }
        }),
    );

    let done = decode(&mut decoder, json!({"type":"message_stop"}));

    assert!(matches!(
        &done.items[0],
        Ok(ChatDelta::Context(context))
            if context.data[0]["citations"][0]["url"] == "https://example.test"
    ));
}
