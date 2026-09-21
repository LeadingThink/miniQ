//! Exercise the production serializers, without sending customer data or model requests.

use super::*;

async fn continue_with_missing_attachment(protocol: ApiProtocol, with_tools: bool) {
    let server =
        CaptureServer::start(vec![final_response(protocol), final_response(protocol)]).await;
    let directory = tempfile::tempdir().unwrap();
    let removed = directory.path().join("wechat-temporary.png");
    let retained = directory.path().join("durable-reference.png");
    let png = crate::missing_images::tests::PNG;
    for path in [&removed, &retained] {
        std::fs::write(path, png).unwrap();
    }
    let mut attachment = ChatMessage::user("Please compare these references when available.");
    attachment.images = [&removed, &retained]
        .into_iter()
        .map(|path| ChatImage {
            path: path.to_string_lossy().into_owned(),
            mime_type: "image/png".into(),
            detail: ImageDetail::High,
        })
        .collect();
    let original = vec![
        ChatMessage::system("test"),
        attachment,
        ChatMessage::assistant("Recorded the references."),
        ChatMessage::user("Continue the text-only part of the task."),
    ];
    std::fs::remove_file(&removed).unwrap();
    let mut executor = Executor::default();
    if !with_tools {
        executor.tools.clear();
    }
    let (events, _receiver) = tokio::sync::mpsc::channel(128);
    let result = run_turn(
        provider(protocol, &server.base_url).as_ref(),
        &executor,
        original,
        events.clone(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.final_text, "done");
    let body = server.body(0);
    assert_eq!(image_count(&body), 1);
    let serialized = body.to_string();
    assert!(serialized.contains("missing_visual_evidence"));
    assert!(serialized.contains(removed.to_str().unwrap()));
    assert!(serialized.contains("Continue the text-only part"));
    assert!(result.provider_history.iter().any(|message| message
        .images
        .iter()
        .any(|image| image.path == removed.to_str().unwrap())));

    // Restoring the original file must make it usable again on the next turn.
    std::fs::write(&removed, png).unwrap();
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
    assert!(!restored.to_string().contains("[Missing visual evidence:"));
    assert_eq!(server.state.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn all_provider_protocols_continue_after_historical_attachment_cleanup() {
    for protocol in [
        ApiProtocol::Responses,
        ApiProtocol::ChatCompletions,
        ApiProtocol::AnthropicMessages,
    ] {
        for with_tools in [true, false] {
            continue_with_missing_attachment(protocol, with_tools).await;
        }
    }
}
