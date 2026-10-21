use super::*;
use crate::{ArchivedImage, ChatImage, ImageDetail, ToolCallRequest, ToolSpec};

fn build_with_attachment_recovery(
    request: &CompletionRequest,
    build: impl FnMut(&CompletionRequest) -> Result<Value, ProviderError>,
) -> Result<Value, ProviderError> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(super::build_with_attachment_recovery(request, None, build))
}

fn image(path: &std::path::Path) -> ChatImage {
    ChatImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png".into(),
        detail: ImageDetail::High,
    }
}

fn request(messages: Vec<ChatMessage>) -> CompletionRequest {
    CompletionRequest {
        context_compact_threshold: None,
        trace: Default::default(),
        messages,
        tools: vec![ToolSpec {
            name: "inspect".into(),
            description: "Inspect images".into(),
            parameters: json!({"type": "object", "properties": {}}),
        }],
        temperature: Some(0.7),
        max_output_tokens: Some(4096),
    }
}

fn encode(request: &CompletionRequest) -> Result<Value, ProviderError> {
    let encoded = request
        .messages
        .iter()
        .flat_map(|message| &message.images)
        .map(|image| crate::image::encode_image(image).map(|encoded| encoded.base64))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "messages": request.messages,
        "tools": request.tools,
        "temperature": request.temperature,
        "max_output_tokens": request.max_output_tokens,
        "encoded": encoded,
    }))
}

#[test]
fn removes_exact_failed_paths_and_preserves_text_valid_pixels_tool_pairs_and_archives() {
    let directory = tempfile::tempdir().unwrap();
    let missing = image(&directory.path().join("missing.png"));
    let valid = image(&directory.path().join("missing.png.copy.png"));
    std::fs::write(&valid.path, b"remaining original pixels").unwrap();
    let mut user = ChatMessage::user("Inspect these images.\nKeep this complete text.");
    user.images = vec![missing.clone(), valid.clone()];
    user.image_archive.push(ArchivedImage {
        id: "original-reference".into(),
        image: missing.clone(),
        sources: vec![],
        current_user_reference: Some(0),
    });
    let mut assistant = ChatMessage::assistant("");
    assistant.tool_calls.push(ToolCallRequest {
        id: "call-1".into(),
        name: "inspect".into(),
        arguments: json!({}),
    });
    let mut result = ChatMessage::tool_result(
        "call-1",
        r#"{"error":"capture failed","actionDispatched":false}"#,
    );
    result.images = vec![missing.clone()];
    let original = request(vec![
        ChatMessage::system("Existing instructions."),
        user,
        assistant,
        result,
    ]);
    let snapshot = serde_json::to_value(&original.messages).unwrap();
    let mut attempts = 0;
    let body = build_with_attachment_recovery(&original, |request| {
        attempts += 1;
        encode(request)
    })
    .unwrap();
    assert_eq!(attempts, 2);
    assert_eq!(
        body["encoded"],
        json!(["cmVtYWluaW5nIG9yaWdpbmFsIHBpeGVscw=="])
    );
    assert_eq!(body["messages"][0], snapshot[0]);
    let notice: Value =
        serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(notice["status"], "unavailable_attachment");
    assert_eq!(notice["path"], missing.path);
    assert!(notice["note"]
        .as_str()
        .unwrap()
        .contains("not instructions"));
    assert_eq!(body["messages"][2]["content"], snapshot[1]["content"]);
    assert_eq!(body["messages"][2]["images"], json!([valid]));
    assert_eq!(
        body["messages"][2]["image_archive"],
        snapshot[1]["image_archive"]
    );
    assert_eq!(body["messages"][3], snapshot[2]);
    assert_eq!(body["messages"][4]["content"], snapshot[3]["content"]);
    assert_eq!(body["messages"][4]["tool_call_id"], "call-1");
    assert_eq!(
        body["tools"],
        serde_json::to_value(&original.tools).unwrap()
    );
    assert_eq!(body["temperature"], json!(0.7f32));
    assert_eq!(body["max_output_tokens"], 4096);
    assert_eq!(serde_json::to_value(&original.messages).unwrap(), snapshot);
}

#[test]
fn each_rebuild_removes_a_failure_without_using_the_network_retry_budget() {
    let directory = tempfile::tempdir().unwrap();
    let mut user = ChatMessage::user("Continue with this text.");
    user.images = (0..12)
        .map(|index| image(&directory.path().join(format!("absent-{index}.png"))))
        .collect();
    let original = request(vec![user]);
    let mut remaining = Vec::new();
    let body = build_with_attachment_recovery(&original, |request| {
        remaining.push(
            request
                .messages
                .iter()
                .map(|message| message.images.len())
                .sum::<usize>(),
        );
        encode(request)
    })
    .unwrap();
    assert_eq!(remaining, (0..=12).rev().collect::<Vec<_>>());
    assert_eq!(body["messages"].as_array().unwrap().len(), 13);
    assert_eq!(body["messages"][12]["content"], "Continue with this text.");
    assert_eq!(original.messages[0].images.len(), 12);
}

#[test]
fn unmatched_attachment_error_stops_immediately() {
    let original = request(vec![ChatMessage::user("Text remains.")]);
    let mut attempts = 0;
    let error = build_with_attachment_recovery(&original, |_| {
        attempts += 1;
        Err(ProviderError::Attachment {
            path: "unmatched.png".into(),
            detail: "local failure".into(),
        })
    })
    .unwrap_err();
    assert_eq!(attempts, 1);
    assert!(
        matches!(error, ProviderError::Attachment { path, detail } if path == "unmatched.png" && detail == "local failure")
    );
    assert_eq!(original.messages[0].content, "Text remains.");
}

#[test]
fn network_authentication_configuration_and_response_errors_are_never_swallowed() {
    let original = request(vec![ChatMessage::user("Text remains.")]);
    let errors = vec![
        ProviderError::Api {
            status: 401,
            body: "invalid key".into(),
            retry_after: None,
        },
        ProviderError::Api {
            status: 500,
            body: "server failure".into(),
            retry_after: None,
        },
        ProviderError::Http(reqwest::Client::new().get("http://[").build().unwrap_err()),
        ProviderError::Config("invalid configuration".into()),
        ProviderError::InvalidResponse("protocol failure".into()),
        ProviderError::Refusal,
        ProviderError::ContextWindowExceeded,
        ProviderError::Transient("overloaded".into()),
    ];
    for error in errors {
        let expected = error.to_string();
        let mut error = Some(error);
        let mut attempts = 0;
        let result = build_with_attachment_recovery(&original, |_| {
            attempts += 1;
            Err(error.take().expect("must not retry unrelated errors"))
        });
        assert_eq!(attempts, 1);
        assert_eq!(result.unwrap_err().to_string(), expected);
    }
}

#[test]
fn image_only_messages_stay_nonempty_after_the_last_failed_image_is_omitted() {
    let directory = tempfile::tempdir().unwrap();
    for mut message in [
        ChatMessage::user(""),
        ChatMessage::tool_result("call-1", ""),
    ] {
        message
            .images
            .push(image(&directory.path().join("absent.png")));
        let original = request(vec![message]);
        let body = build_with_attachment_recovery(&original, encode).unwrap();
        assert!(body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("could not be read"));
        assert_eq!(
            body["messages"][1]["role"],
            serde_json::to_value(original.messages[0].role).unwrap()
        );
        assert_eq!(
            body["messages"][1]["tool_call_id"],
            serde_json::to_value(&original.messages[0].tool_call_id).unwrap()
        );
        assert!(original.messages[0].content.is_empty());
    }
}

#[test]
fn restored_file_is_sent_again_and_success_does_not_clone_or_inject_notices() {
    let directory = tempfile::tempdir().unwrap();
    let attached = image(&directory.path().join("restored.png"));
    let mut user = ChatMessage::user("Read the original image.");
    user.images.push(attached.clone());
    let original = request(vec![user]);
    let omitted = build_with_attachment_recovery(&original, encode).unwrap();
    assert_eq!(omitted["encoded"], json!([]));
    std::fs::write(&attached.path, b"original pixels restored").unwrap();
    let mut attempts = 0;
    let restored = build_with_attachment_recovery(&original, |outgoing| {
        assert!(std::ptr::eq(outgoing, &original));
        attempts += 1;
        encode(outgoing)
    })
    .unwrap();
    assert_eq!(attempts, 1);
    assert_eq!(
        restored["messages"],
        serde_json::to_value(&original.messages).unwrap()
    );
    assert_eq!(restored["encoded"].as_array().unwrap().len(), 1);
}

#[test]
fn identical_pixels_at_different_paths_are_sent_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.png");
    let second = dir.path().join("second.png");
    std::fs::write(&first, b"identical original pixels").unwrap();
    std::fs::write(&second, b"identical original pixels").unwrap();
    let mut old = ChatMessage::tool_result("old", "old observation metadata");
    old.images.push(image(&first));
    let mut latest = ChatMessage::tool_result("new", "latest observation metadata");
    latest.images.push(image(&second));
    let original = request(vec![old, latest]);
    let body = build_with_attachment_recovery(&original, |r| {
        let count = r.messages.iter().map(|m| m.images.len()).sum::<usize>();
        Ok(json!({"model":"test", "count":count, "messages":r.messages}))
    })
    .unwrap();
    assert_eq!(body["count"], 1);
    assert_eq!(original.messages[0].images.len(), 1);
    assert_eq!(original.messages[1].images.len(), 1);
    assert!(body.to_string().contains("duplicate"));
}

#[test]
fn aggregate_image_payload_is_bounded_and_latest_observation_survives() {
    let dir = tempfile::tempdir().unwrap();
    let mut messages = vec![];
    for index in 0..20 {
        let path = dir.path().join(format!("{index}.png"));
        std::fs::write(&path, vec![index as u8; 1024 * 1024]).unwrap();
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls.push(ToolCallRequest {
            id: format!("call-{index}"),
            name: "view_image".into(),
            arguments: json!({}),
        });
        messages.push(assistant);
        let mut result =
            ChatMessage::tool_result(format!("call-{index}"), format!("observation-{index}"));
        result.images.push(image(&path));
        messages.push(result);
    }
    let original = request(messages);
    let body = build_with_attachment_recovery(&original, |r| {
        let mut input = vec![];
        for m in &r.messages {
            let mut content = vec![json!({"type":"input_text","text":m.content})];
            for im in &m.images {
                let encoded = crate::image::encode_image(im)?;
                content.push(json!({"type":"input_image","image_url":format!("data:{};base64,{}",encoded.mime_type,encoded.base64)}));
            }
            input.push(json!({"role":"user","content":content}));
        }
        Ok(json!({"model":"test","input":input}))
    }).unwrap();
    let wire = serde_json::to_vec(&body).unwrap();
    assert!(
        wire.len() <= 17 * 1024 * 1024,
        "unbounded {} byte payload",
        wire.len()
    );
    let input = body["input"].as_array().unwrap();
    assert!(input.iter().any(|m| m["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["text"] == "observation-19")));
    assert!(input.last().unwrap()["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "input_image"));
    assert_eq!(
        original
            .messages
            .iter()
            .map(|m| m.images.len())
            .sum::<usize>(),
        20
    );
    assert!(body.to_string().contains("request_image_budget"));
}

#[test]
fn oversized_non_image_request_is_rejected_without_truncating_text() {
    let original = request(vec![ChatMessage::user("x".repeat(25 * 1024 * 1024))]);
    let result = build_with_attachment_recovery(&original, |r| {
        Ok(json!({"model":"test","input":r.messages}))
    });
    assert!(result.is_err(), "oversized body was allowed onto the wire");
    assert_eq!(original.messages[0].content.len(), 25 * 1024 * 1024);
}

#[test]
fn reduced_images_reach_the_model_with_a_system_notice_first() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scan.png");
    image::RgbImage::from_pixel(3200, 2400, image::Rgb([15, 100, 210]))
        .save(&path)
        .unwrap();
    let mut user = ChatMessage::user("what does this say");
    user.images.push(ChatImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png".into(),
        detail: ImageDetail::Preview,
    });

    let body = build_with_attachment_recovery(&request(vec![user]), encode).unwrap();
    let notice = &body["messages"][0];
    assert_eq!(notice["role"], "system");
    let text = notice["content"].as_str().unwrap();
    assert!(text.contains("<image_resize_notice>"));
    assert!(text.contains("was resized from 3200x2400 to"));
    assert_eq!(body["messages"][1]["role"], "user");
}
