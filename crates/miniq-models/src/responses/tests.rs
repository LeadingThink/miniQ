use super::*;
use crate::responses_request::shell_result_item;
use crate::ChatMessage;
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
fn advertises_patch_and_shell_as_standard_responses_functions() {
    let mut request = request(vec![ChatMessage::user("edit")]);
    request.tools = vec![
        ToolSpec {
            name: "apply_patch".into(),
            description: "patch".into(),
            parameters: json!({"type":"object","properties":{"patch":{"type":"string"}}}),
        },
        ToolSpec {
            name: "shell_batch".into(),
            description: "shell".into(),
            parameters: json!({"type":"object","properties":{"commands":{"type":"array"}}}),
        },
    ];
    let body = provider().build_body(&request);
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["name"], "apply_patch");
    assert_eq!(
        body["tools"][0]["parameters"]["properties"]["patch"]["type"],
        "string"
    );
    assert_eq!(body["tools"][1]["type"], "function");
    assert_eq!(body["tools"][1]["name"], "shell_batch");
    assert_eq!(
        body["tools"][1]["parameters"]["properties"]["commands"]["type"],
        "array"
    );
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
fn replays_native_patch_and_shell_results_with_their_output_types() {
    let mut assistant = ChatMessage::assistant("");
    assistant.provider_context = Some(ProviderContext {
        protocol: ApiProtocol::Responses,
        data: json!([
            {"type":"apply_patch_call","call_id":"patch-1","operation":{"type":"delete_file","path":"old.txt"}},
            {"type":"shell_call","call_id":"shell-1","action":{"commands":["pwd"]}}
        ]),
    });
    let body = provider().build_body(&request(vec![
        assistant,
        ChatMessage::tool_result("patch-1", r#"{"status":"completed"}"#),
        ChatMessage::tool_result("shell-1", r#"{"output":[{"stdout":"ok","stderr":"","outcome":{"type":"exit","exit_code":0}}],"maxOutputLength":4096}"#),
    ]));
    assert_eq!(body["input"][2]["type"], "apply_patch_call_output");
    assert_eq!(body["input"][2]["status"], "completed");
    assert_eq!(body["input"][3]["type"], "shell_call_output");
    assert_eq!(body["input"][3]["output"][0]["outcome"]["exit_code"], 0);
    assert_eq!(body["input"][3]["max_output_length"], 4096);
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
fn decodes_native_patch_and_shell_calls() {
    let patch = decode(
        &mut ResponsesDecoder::default(),
        json!({
            "type":"response.output_item.done","output_index":0,
            "item":{"type":"apply_patch_call","id":"apc-1","call_id":"patch-1","operation":{"type":"update_file","path":"a.txt","diff":"@@\n-old\n+new\n"}}
        }),
    );
    assert!(matches!(
        &patch.items[0],
        Ok(ChatDelta::ToolCall(call))
            if call.id == "patch-1"
                && call.name == "apply_patch"
                && call.arguments["operation"]["path"] == "a.txt"
    ));

    let shell = decode(
        &mut ResponsesDecoder::default(),
        json!({
            "type":"response.output_item.done","output_index":0,
            "item":{"type":"shell_call","id":"sh-1","call_id":"shell-1","action":{"commands":["pwd","git status"],"timeout_ms":120000,"max_output_length":4096}}
        }),
    );
    assert!(matches!(
        &shell.items[0],
        Ok(ChatDelta::ToolCall(call))
            if call.id == "shell-1"
                && call.name == "shell_batch"
                && call.arguments["commands"][1] == "git status"
                && call.arguments["timeoutMs"] == 120000
    ));
}

#[test]
fn quotes_legacy_local_shell_argv_without_losing_argument_boundaries() {
    let arguments = shell_arguments(&json!({
        "action":{"command":["printf", "%s", "two words"]}
    }));
    assert_eq!(arguments["commands"][0], "'printf' '%s' 'two words'");

    let invalid = shell_arguments(&json!({"action":{"command":["echo", 1]}}));
    assert_eq!(invalid["commands"], json!([]));
}

#[test]
fn shell_error_results_use_a_valid_nonzero_exit_outcome() {
    let result = shell_result_item("shell-1", r#"{"error":"denied"}"#);
    assert_eq!(result["output"][0]["outcome"]["exit_code"], 1);
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

    let context_overflow = decode(
        &mut ResponsesDecoder::default(),
        json!({
            "type":"response.failed",
            "response":{"error":{"message":"Your input exceeds the context window of this model."}}
        }),
    );
    assert!(matches!(
        context_overflow.items[0],
        Err(ProviderError::ContextWindowExceeded)
    ));
}
