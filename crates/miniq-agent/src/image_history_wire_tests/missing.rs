//! Production serializers retry attachment encoding locally, never task execution.

use super::*;

#[derive(Clone, Copy, Debug)]
enum Failure {
    Missing,
    Directory,
    TooLarge,
    InvalidPreview,
    #[cfg(unix)]
    PermissionDenied,
}

#[derive(Clone, Copy, Debug)]
enum Source {
    UserImages,
    ArchivedReferences,
    ToolResult,
}

struct Attachments {
    _directory: tempfile::TempDir,
    failed: std::path::PathBuf,
    retained: std::path::PathBuf,
    failure: Failure,
}

impl Attachments {
    fn new(failure: Failure) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let failed = directory.path().join("unavailable-reference.png");
        let retained = directory.path().join("durable-reference.png");
        for path in [&failed, &retained] {
            std::fs::write(path, crate::missing_images::tests::PNG).unwrap();
        }
        match failure {
            Failure::Missing => std::fs::remove_file(&failed).unwrap(),
            Failure::Directory => {
                std::fs::remove_file(&failed).unwrap();
                std::fs::create_dir(&failed).unwrap();
            }
            Failure::TooLarge => std::fs::File::create(&failed)
                .unwrap()
                .set_len(21 * 1024 * 1024)
                .unwrap(),
            Failure::InvalidPreview => std::fs::write(&failed, b"invalid PNG pixels").unwrap(),
            #[cfg(unix)]
            Failure::PermissionDenied => {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&failed, std::fs::Permissions::from_mode(0o000)).unwrap();
                assert_eq!(
                    std::fs::File::open(&failed).unwrap_err().kind(),
                    std::io::ErrorKind::PermissionDenied,
                    "fixture must exercise an actual access denial"
                );
            }
        }
        Self {
            _directory: directory,
            failed,
            retained,
            failure,
        }
    }

    fn images(&self) -> Vec<ChatImage> {
        [&self.failed, &self.retained]
            .into_iter()
            .map(|path| ChatImage {
                path: path.to_string_lossy().into_owned(),
                mime_type: "image/png".into(),
                detail: if matches!(self.failure, Failure::InvalidPreview) {
                    ImageDetail::Preview
                } else {
                    ImageDetail::High
                },
            })
            .collect()
    }

    fn restore(&self) {
        if matches!(self.failure, Failure::Directory) {
            std::fs::remove_dir(&self.failed).unwrap();
        }
        #[cfg(unix)]
        if matches!(self.failure, Failure::PermissionDenied) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.failed, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        std::fs::write(&self.failed, crate::missing_images::tests::PNG).unwrap();
    }
}

fn source_history(source: Source, images: Vec<ChatImage>) -> Vec<ChatMessage> {
    let mut history = vec![ChatMessage::system("test")];
    match source {
        Source::UserImages | Source::ArchivedReferences => {
            let mut user = ChatMessage::user("Please compare these references when available.");
            user.images = images;
            history.extend([user, ChatMessage::assistant("Recorded the references.")]);
        }
        Source::ToolResult => {
            history.push(ChatMessage::user("Inspect these references."));
            let mut assistant = ChatMessage::assistant("Inspecting the references.");
            assistant.tool_calls.push(ToolCallRequest {
                id: "inspection-1".into(),
                name: "view_image".into(),
                arguments: json!({"path":images[0].path}),
            });
            let mut result = ChatMessage::tool_result(
                "inspection-1",
                json!({
                    "source_payload":"tool-json-preserved", "page":3
                })
                .to_string(),
            );
            result.images = images;
            history.extend([assistant, result]);
        }
    }
    if matches!(source, Source::ArchivedReferences) {
        let archive = crate::visual_history::VisualHistory::from_messages(&history);
        history = vec![ChatMessage::system(
            "Compacted text; original visual references remain archived.",
        )];
        archive.persist(&mut history);
    }
    history.push(ChatMessage::user(
        "Continue the text-only part of the task.",
    ));
    history
}

// Anthropic combines system messages into one string; Responses and Chat keep
// separate entries. Decode complete JSON lines rather than matching policy text.
fn embedded_objects(value: &Value) -> Vec<Value> {
    match value {
        Value::String(text) => text
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .filter(Value::is_object)
            .collect(),
        Value::Array(values) => values.iter().flat_map(embedded_objects).collect(),
        Value::Object(object) => object.values().flat_map(embedded_objects).collect(),
        _ => Vec::new(),
    }
}

fn field_count(value: &Value, field: &str, expected: &str) -> usize {
    match value {
        Value::Array(values) => values
            .iter()
            .map(|value| field_count(value, field, expected))
            .sum(),
        Value::Object(object) => {
            usize::from(object.get(field).is_some_and(|value| value == expected))
                + object
                    .values()
                    .map(|value| field_count(value, field, expected))
                    .sum::<usize>()
        }
        _ => 0,
    }
}

fn assert_failed_attachment_request(
    body: &Value,
    protocol: ApiProtocol,
    source: Source,
    attachments: &Attachments,
) {
    assert_eq!(
        image_count(body),
        1,
        "{protocol:?} {source:?} {:?}",
        attachments.failure
    );
    let embedded = embedded_objects(body);
    let notices = embedded
        .iter()
        .filter(|value| value["status"] == "unavailable_attachment")
        .collect::<Vec<_>>();
    assert_eq!(
        notices.len(),
        1,
        "one precise failure notice per removed path"
    );
    assert_eq!(notices[0]["path"], attachments.failed.to_str().unwrap());
    assert!(!notices[0]["detail"].as_str().unwrap().is_empty());
    assert!(!notices[0]["note"].as_str().unwrap().is_empty());
    assert!(body.to_string().contains("Continue the text-only part"));
    if matches!(source, Source::ToolResult) {
        assert!(embedded
            .iter()
            .any(|value| value["source_payload"] == "tool-json-preserved" && value["page"] == 3));
        match protocol {
            ApiProtocol::Responses => assert_eq!(field_count(body, "call_id", "inspection-1"), 2),
            ApiProtocol::AnthropicMessages => {
                assert_eq!(field_count(body, "id", "inspection-1"), 1);
                assert_eq!(field_count(body, "tool_use_id", "inspection-1"), 1);
            }
            ApiProtocol::ChatCompletions => {
                assert_eq!(field_count(body, "id", "inspection-1"), 1);
                assert_eq!(field_count(body, "tool_call_id", "inspection-1"), 1);
            }
            ApiProtocol::Auto => unreachable!(),
        }
    }
}

async fn continue_with_failed_attachment(
    protocol: ApiProtocol,
    with_tools: bool,
    failure: Failure,
    source: Source,
) {
    let server =
        CaptureServer::start(vec![final_response(protocol), final_response(protocol)]).await;
    let attachments = Attachments::new(failure);
    let original = source_history(source, attachments.images());
    let mut executor = Executor::default();
    if !with_tools {
        executor.tools.clear();
    }
    let (events, _receiver) = tokio::sync::mpsc::channel(128);
    let result = run_turn(
        provider(protocol, &server.base_url).as_ref(),
        &executor,
        original.clone(),
        events.clone(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.final_text, "done");
    assert_failed_attachment_request(&server.body(0), protocol, source, &attachments);
    assert_eq!(
        server.state.requests.lock().unwrap().len(),
        1,
        "local rebuild must not retry HTTP"
    );
    assert!(
        executor.calls.lock().unwrap().is_empty(),
        "no task/tool side effect was replayed"
    );
    let original_without_catalog = original
        .iter()
        .filter(|message| !crate::visual_history::is_catalog(message))
        .collect::<Vec<_>>();
    let preserved = result
        .provider_history
        .iter()
        .filter(|message| !crate::visual_history::is_catalog(message))
        .take(original_without_catalog.len())
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_value(preserved).unwrap(),
        serde_json::to_value(original_without_catalog).unwrap()
    );
    let stored = crate::visual_history::VisualHistory::from_messages(&result.provider_history);
    assert!(stored
        .entries()
        .iter()
        .any(|entry| entry.image.path == attachments.failed.to_str().unwrap()));
    attachments.restore();
    let mut resumed = result.provider_history;
    resumed.push(ChatMessage::user("The reference is restored; continue."));
    run_turn(
        provider(protocol, &server.base_url).as_ref(),
        &executor,
        resumed,
        events,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let restored = server.body(1);
    assert_eq!(image_count(&restored), 2);
    assert!(embedded_objects(&restored)
        .iter()
        .all(|value| value["status"] != "unavailable_attachment"));
    assert_eq!(server.state.requests.lock().unwrap().len(), 2);
    assert!(executor.calls.lock().unwrap().is_empty());
}

fn protocols() -> [ApiProtocol; 3] {
    [
        ApiProtocol::Responses,
        ApiProtocol::ChatCompletions,
        ApiProtocol::AnthropicMessages,
    ]
}

#[tokio::test]
async fn all_provider_protocols_rebuild_only_failed_attachment_fields_before_sending() {
    let failures = [
        Failure::Missing,
        Failure::Directory,
        Failure::TooLarge,
        Failure::InvalidPreview,
        #[cfg(unix)]
        Failure::PermissionDenied,
    ];
    for protocol in protocols() {
        for with_tools in [true, false] {
            for failure in failures {
                continue_with_failed_attachment(protocol, with_tools, failure, Source::UserImages)
                    .await;
            }
        }
    }
}

#[tokio::test]
async fn restored_catalog_references_and_tool_image_results_use_the_same_rebuild_path() {
    for protocol in protocols() {
        for source in [Source::ArchivedReferences, Source::ToolResult] {
            continue_with_failed_attachment(protocol, true, Failure::Missing, source).await;
        }
    }
}

#[tokio::test]
async fn an_image_only_message_keeps_a_valid_text_block_after_its_last_image_fails() {
    for protocol in protocols() {
        let server = CaptureServer::start(vec![final_response(protocol)]).await;
        let directory = tempfile::tempdir().unwrap();
        let mut image_only = ChatMessage::user("");
        image_only.images.push(ChatImage {
            path: directory
                .path()
                .join("gone.png")
                .to_string_lossy()
                .into_owned(),
            mime_type: "image/png".into(),
            detail: ImageDetail::High,
        });
        let history = vec![
            ChatMessage::system("test"),
            image_only,
            ChatMessage::assistant("Waiting for the next request."),
            ChatMessage::user("Continue the text-only part."),
        ];
        let executor = Executor {
            tools: Vec::new(),
            calls: Default::default(),
        };
        let (events, _receiver) = tokio::sync::mpsc::channel(32);
        let result = run_turn(
            provider(protocol, &server.base_url).as_ref(),
            &executor,
            history,
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.final_text, "done");
        let body = server.body(0);
        assert_eq!(image_count(&body), 0);
        let messages = if protocol == ApiProtocol::Responses {
            &body["input"]
        } else {
            &body["messages"]
        };
        let users = messages
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .collect::<Vec<_>>();
        assert_eq!(
            users.len(),
            2,
            "failed image-only turn must remain explicit: {protocol:?}"
        );
        for message in users {
            match &message["content"] {
                Value::String(text) => assert!(!text.trim().is_empty()),
                Value::Array(blocks) => {
                    assert!(
                        !blocks.is_empty(),
                        "no empty user content array: {protocol:?}"
                    );
                    assert!(blocks.iter().all(|block| matches!(
                        block["type"].as_str(),
                        Some("text" | "input_text")
                    ) && block["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty())));
                }
                _ => panic!("invalid user content: {protocol:?}"),
            }
        }
        assert_eq!(
            embedded_objects(&body)
                .iter()
                .filter(|value| value["status"] == "unavailable_attachment")
                .count(),
            1
        );
        assert_eq!(server.state.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn native_computer_replay_preserves_the_completed_action_when_screenshots_fail() {
    for retain_valid_image in [true, false] {
        let protocol = ApiProtocol::Responses;
        let server = CaptureServer::start(vec![final_response(protocol)]).await;
        let attachments = Attachments::new(Failure::Missing);
        let arguments = json!({"action":"click","x":120,"y":60,"button":"left"});
        let mut assistant = ChatMessage::assistant("");
        assistant.tool_calls.push(ToolCallRequest {
            id: "clicked".into(),
            name: "computer_use".into(),
            arguments: arguments.clone(),
        });
        assistant.provider_context = Some(ProviderContext {
            protocol,
            data: json!([{
                "type":"computer_call", "id":"native-clicked", "call_id":"clicked",
                "action":{"type":"click","x":120,"y":60,"button":"left"},
                "pending_safety_checks":[],
            }]),
        });
        let mut result =
            ChatMessage::tool_result("clicked", json!({"action_completed":true}).to_string());
        result.images = attachments.images();
        if !retain_valid_image {
            result.images.pop();
        }
        let original_images = result.images.clone();
        let executor = Executor::default();
        let (events, _receiver) = tokio::sync::mpsc::channel(32);
        let outcome = run_turn(
            provider(protocol, &server.base_url).as_ref(),
            &executor,
            vec![
                ChatMessage::user("Click once."),
                assistant,
                result,
                ChatMessage::user("Continue the text-only part."),
            ],
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let body = server.body(0);
        assert_eq!(image_count(&body), usize::from(retain_valid_image));
        let pair = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["call_id"] == "clicked")
            .collect::<Vec<_>>();
        assert_eq!(pair.len(), 2);
        if retain_valid_image {
            assert_eq!(pair[0]["type"], "computer_call");
            assert_eq!(pair[1]["type"], "computer_call_output");
            assert_eq!(pair[1]["output"]["type"], "computer_screenshot");
        } else {
            assert_eq!(pair[0]["type"], "function_call");
            assert_eq!(pair[0]["name"], "computer_use");
            assert_eq!(
                serde_json::from_str::<Value>(pair[0]["arguments"].as_str().unwrap()).unwrap(),
                arguments
            );
            assert_eq!(pair[1]["type"], "function_call_output");
        }
        let embedded = embedded_objects(&body);
        assert!(embedded
            .iter()
            .any(|value| value["action_completed"] == true));
        assert_eq!(
            embedded
                .iter()
                .filter(|value| value["status"] == "unavailable_attachment")
                .count(),
            1
        );
        assert_eq!(
            outcome
                .provider_history
                .iter()
                .find(|message| message.tool_call_id.as_deref() == Some("clicked"))
                .unwrap()
                .images,
            original_images
        );
        assert_eq!(server.state.requests.lock().unwrap().len(), 1);
        assert!(
            executor.calls.lock().unwrap().is_empty(),
            "a completed click must never run again"
        );
    }
}
