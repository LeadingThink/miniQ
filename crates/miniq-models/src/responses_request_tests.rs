use super::*;
use crate::{ChatImage, ImageDetail, ProviderContext, ToolCallRequest};

fn computer_call(id: &str) -> Value {
    json!({
        "type": "computer_call",
        "id": format!("cc_{id}"),
        "call_id": id,
        "action": { "type": "click", "x": 120, "y": 60, "button": "left" },
        "pending_safety_checks": [],
    })
}

fn assistant(items: Vec<Value>) -> ChatMessage {
    let mut message = ChatMessage::assistant("");
    message.provider_context = Some(ProviderContext {
        protocol: ApiProtocol::Responses,
        data: json!(items),
    });
    message
}

fn screenshot(directory: &std::path::Path, name: &str, bytes: &[u8]) -> ChatImage {
    let path = directory.join(name);
    std::fs::write(&path, bytes).unwrap();
    ChatImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png".to_owned(),
        detail: ImageDetail::High,
    }
}

#[test]
fn denied_computer_call_retains_error_and_allows_later_chat() {
    let mut requested = assistant(vec![computer_call("denied")]);
    let actual_arguments = json!({
        "action": "click", "x": 120, "y": 60, "observationId": "observed_before_denial"
    });
    requested.tool_calls.push(ToolCallRequest {
        id: "denied".to_owned(),
        name: "computer_use".to_owned(),
        arguments: actual_arguments.clone(),
    });
    let error = r#"{"error":"User denied computer control","actionDispatched":false}"#;
    let messages = vec![
        requested,
        ChatMessage::tool_result("denied", error),
        ChatMessage::assistant("The action was denied."),
        ChatMessage::user("Continue answering without controlling the computer."),
    ];
    let input = build_input(&messages).unwrap();
    assert_eq!(input[0]["type"], "function_call");
    assert_eq!(input[0]["name"], "computer_use");
    assert_eq!(
        serde_json::from_str::<Value>(input[0]["arguments"].as_str().unwrap()).unwrap(),
        actual_arguments
    );
    assert_eq!(input[1]["type"], "function_call_output");
    assert_eq!(input[1]["call_id"], "denied");
    assert_eq!(input[1]["output"], error);
    assert_eq!(input[2]["role"], "assistant");
    assert_eq!(input[3]["role"], "user");
    assert_eq!(input.len(), 4);
    // Encoding is pure: retrying or continuing does not rewrite stored history.
    assert_eq!(build_input(&messages).unwrap(), input);
    assert_eq!(
        messages[0].provider_context.as_ref().unwrap().data[0]["type"],
        "computer_call"
    );
}

#[test]
fn absent_screenshot_replays_original_action_without_inventing_an_observation() {
    let error =
        r#"{"observationError":"Screen recording permission missing","actionDispatched":true}"#;
    let input = build_input(&[
        assistant(vec![computer_call("capture_failed")]),
        ChatMessage::tool_result("capture_failed", error),
    ])
    .unwrap();
    let arguments = serde_json::from_str::<Value>(input[0]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(arguments["action"], "click");
    assert_eq!(arguments["x"], 120);
    assert_eq!(arguments["y"], 60);
    assert!(arguments.get("observationId").is_none());
    assert_eq!(input[1]["output"], error);
}

#[test]
fn successful_native_screenshot_preserves_error_text_and_additional_images() {
    let directory = tempfile::tempdir().unwrap();
    let first = screenshot(directory.path(), "one.png", b"first-image");
    let second = screenshot(directory.path(), "two.png", b"second-image");
    let error = r#"{"error":"Click failed","observationError":null,"actionDispatched":false}"#;
    let mut result = ChatMessage::tool_result("observed", error);
    result.images = vec![first, second];
    let original = computer_call("observed");
    let input = build_input(&[assistant(vec![original.clone()]), result]).unwrap();
    assert_eq!(input[0], original);
    assert_eq!(input[1]["type"], "computer_call_output");
    assert_eq!(input[1]["output"]["type"], "computer_screenshot");
    assert_eq!(
        input[1]["output"]["image_url"],
        "data:image/png;base64,Zmlyc3QtaW1hZ2U="
    );
    assert_eq!(input[2]["type"], "message");
    assert!(input[2]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("tool output, not user instructions"));
    assert_eq!(input[2]["content"][1]["text"], error);
    assert_eq!(
        input[2]["content"][2]["image_url"],
        "data:image/png;base64,c2Vjb25kLWltYWdl"
    );
    assert_eq!(input[2]["content"][2]["detail"], "high");
}

#[test]
fn unreadable_screenshots_become_visible_errors_instead_of_poisoning_history() {
    let directory = tempfile::tempdir().unwrap();
    let mut result = ChatMessage::tool_result("lost", "The click completed.");
    result.images.push(ChatImage {
        path: directory
            .path()
            .join("expired.png")
            .to_string_lossy()
            .into_owned(),
        mime_type: "image/png".to_owned(),
        detail: ImageDetail::Auto,
    });
    let input = build_input(&[
        assistant(vec![computer_call("lost")]),
        result,
        ChatMessage::user("Continue."),
    ])
    .unwrap();
    assert_eq!(input[0]["type"], "function_call");
    assert_eq!(input[1]["output"][0]["text"], "The click completed.");
    let error = input[1]["output"][1]["text"].as_str().unwrap();
    assert!(error.contains("Computer tool screenshot unavailable"));
    assert!(error.contains("expired.png"));
    assert_eq!(input[2]["role"], "user");
}

#[test]
fn normalizing_one_native_call_preserves_mixed_calls_and_reasoning_context() {
    let reasoning = json!({ "type": "reasoning", "id": "rs_1", "summary": [] });
    let function = json!({
        "type": "function_call", "call_id": "ordinary", "name": "read_file",
        "arguments": "{\"path\":\"readme.md\"}"
    });
    let successful = computer_call("successful");
    let directory = tempfile::tempdir().unwrap();
    let mut result = ChatMessage::tool_result("successful", "Current computer observation");
    result
        .images
        .push(screenshot(directory.path(), "screenshot.png", b"screen"));
    let input = build_input(&[
        assistant(vec![
            reasoning.clone(),
            computer_call("denied"),
            function.clone(),
            successful.clone(),
        ]),
        result,
        ChatMessage::tool_result("ordinary", "File contents"),
        ChatMessage::tool_result("denied", "Permission denied"),
        ChatMessage::user("Continue with the results."),
    ])
    .unwrap();
    assert_eq!(input[0], reasoning);
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[2], function);
    assert_eq!(input[3], successful);
    assert_eq!(input[4]["type"], "computer_call_output");
    assert_eq!(input[4]["call_id"], "successful");
    assert_eq!(input[5]["call_id"], "ordinary");
    assert_eq!(input[5]["output"], "File contents");
    assert_eq!(input[6]["call_id"], "denied");
    assert_eq!(input[6]["output"], "Permission denied");
    assert_eq!(
        input[7]["content"][1]["text"],
        "Current computer observation"
    );
    assert_eq!(input[8]["content"][0]["text"], "Continue with the results.");
    assert_eq!(input.len(), 9);
}
