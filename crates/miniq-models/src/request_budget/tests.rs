use super::*;
use crate::{ChatImage, ImageDetail, ToolCallRequest};

fn request(messages: Vec<ChatMessage>) -> CompletionRequest {
    CompletionRequest {
        messages,
        tools: vec![],
        temperature: None,
        max_output_tokens: None,
        trace: Default::default(),
        context_compact_threshold: None,
    }
}
fn image(path: &std::path::Path) -> ChatImage {
    ChatImage {
        path: path.to_string_lossy().into(),
        mime_type: "image/png".into(),
        detail: ImageDetail::High,
    }
}
#[test]
fn wire_counter_matches_exact_utf8_model_first_bytes() {
    let body = json!({"model":"模型","input":"引号\" 换行\n 中文","reasoning":{"encrypted_content":"opaque unchanged"}});
    assert_eq!(
        wire_size(&body).unwrap(),
        serde_json::to_vec(&crate::request_body::ModelFirstRequest(&body))
            .unwrap()
            .len()
    );
}
#[test]
fn counts_all_protocol_image_shapes_but_not_text_or_remote_urls() {
    let body = json!([
        {"type":"input_image","image_url":"data:image/png;base64,AAAA"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,BBBB"}},
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"CCCC"}},
        {"type":"screenshot","image_url":"data:image/png;base64,DDDD"},
        {"type":"image_url","image_url":{"url":"https://example.com/image.png"}},
        {"type":"input_text","text":"data:image/png;base64,SHOULDNOTCOUNT"}
    ]);
    assert_eq!(
        image_wire_size(&body),
        3 * "data:image/png;base64,AAAA".len() + 4
    );
}
#[test]
fn current_user_pixels_win_over_a_repeated_tool_observation() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("user.png");
    let b = dir.path().join("tool.png");
    std::fs::write(&a, b"same pixels").unwrap();
    std::fs::write(&b, b"same pixels").unwrap();
    let mut user = ChatMessage::user("compare this reference");
    user.images.push(image(&a));
    let mut tool=ChatMessage::tool_result("call","{\"error\":\"original error\",\"visualHistory\":{\"images\":[{\"id\":\"img_2\",\"included\":true}]}}");
    tool.images.push(image(&b));
    let r = request(vec![user, tool]);
    let snapshot = serde_json::to_value(&r.messages).unwrap();
    let projected = deduplicate(&r);
    assert_eq!(
        projected
            .messages
            .iter()
            .find(|m| m.role == ChatRole::User)
            .unwrap()
            .images
            .len(),
        1
    );
    let tool = projected
        .messages
        .iter()
        .find(|m| m.role == ChatRole::Tool)
        .unwrap();
    let value: Value = serde_json::from_str(&tool.content).unwrap();
    assert_eq!(value["error"], "original error");
    assert_eq!(value["visualHistory"]["images"][0]["included"], false);
    assert_eq!(serde_json::to_value(&r.messages).unwrap(), snapshot);
}
#[test]
fn single_current_user_batch_cannot_be_silently_evicted() {
    let dir = tempfile::tempdir().unwrap();
    let mut user = ChatMessage::user("compare all 14 pictures");
    for i in 0..14 {
        let path = dir.path().join(format!("{i}.png"));
        std::fs::write(&path, vec![i; 1024 * 1024]).unwrap();
        user.images.push(image(&path));
    }
    let r = request(vec![user]);
    let mut wire = deduplicate(&r);
    let error = trim_images(&mut wire).unwrap_err();
    assert!(matches!(error, ProviderError::RequestTooLarge { .. }));
    assert!(!error.is_retryable());
    assert_eq!(r.messages[0].images.len(), 14);
}

#[test]
fn oversized_current_user_batch_uses_provider_previews_without_mutating_sources() {
    let dir = tempfile::tempdir().unwrap();
    let mut user = ChatMessage::user("send these pictures");
    let mut originals = Vec::new();
    for i in 0..4 {
        let path = dir.path().join(format!("preview-{i}.png"));
        let mut bytes = Vec::new();
        image::RgbImage::from_pixel(3000, 2000, image::Rgb([15, 100, 210]))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes.resize(5 * 1024 * 1024 + i, 7);
        std::fs::write(&path, &bytes).unwrap();
        originals.push((path.clone(), bytes));
        user.images.push(image(&path));
    }
    let r = request(vec![user]);
    let mut outgoing = deduplicate(&r);
    trim_images(&mut outgoing).unwrap();
    assert!(outgoing.messages[0]
        .images
        .iter()
        .all(|image| image.detail == ImageDetail::Preview));
    assert!(r.messages[0]
        .images
        .iter()
        .all(|image| image.detail == ImageDetail::High));
    for (path, bytes) in originals {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
#[test]
fn latest_comparison_batch_and_tool_pairs_are_protected() {
    let dir = tempfile::tempdir().unwrap();
    let mut messages = vec![];
    for step in 0..3 {
        let mut assistant = ChatMessage::assistant("");
        for i in 0..2 {
            let id = format!("{step}-{i}");
            assistant.tool_calls.push(ToolCallRequest {
                id: id.clone(),
                name: "view_image".into(),
                arguments: json!({}),
            });
        }
        messages.push(assistant);
        for i in 0..2 {
            let path = dir.path().join(format!("{step}-{i}.png"));
            std::fs::write(&path, [step, i]).unwrap();
            let mut result = ChatMessage::tool_result(format!("{step}-{i}"), "{}");
            result.images.push(image(&path));
            messages.push(result);
        }
    }
    let mut r = request(messages);
    for _ in 0..4 {
        assert!(evict_oldest(&mut r));
    }
    assert!(!evict_oldest(&mut r));
    assert_eq!(r.messages.iter().flat_map(|m| &m.images).count(), 2);
    assert_eq!(
        r.messages
            .iter()
            .filter(|m| m.role == ChatRole::Tool)
            .count(),
        6
    );
    assert_eq!(
        r.messages.iter().map(|m| m.tool_calls.len()).sum::<usize>(),
        6
    );
}

#[tokio::test]
async fn all_protocols_block_oversized_current_images_before_http() {
    use crate::{
        AnthropicProvider, ModelProvider, OpenAiCompatProvider, ProviderConfig, ResponsesProvider,
    };
    use axum::{routing::post, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let server = Router::new().fallback(post(move || {
        let count = requests.clone();
        async move {
            count.fetch_add(1, Ordering::SeqCst);
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = ProviderConfig {
        base_url: format!("http://{}", listener.local_addr().unwrap()),
        api_key: "test-only".into(),
        model: "test".into(),
        api_protocol: Default::default(),
        reasoning_effort: None,
    };
    let handle = tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let mut user = ChatMessage::user("all images are required");
    for i in 0..14 {
        let path = dir.path().join(format!("{i}.png"));
        std::fs::write(&path, vec![i; 1024 * 1024]).unwrap();
        user.images.push(image(&path));
    }
    let providers: Vec<Box<dyn ModelProvider>> = vec![
        Box::new(ResponsesProvider::new(config.clone())),
        Box::new(OpenAiCompatProvider::new(config.clone())),
        Box::new(AnthropicProvider::new(config)),
    ];
    for provider in providers {
        let result = provider.stream_complete(request(vec![user.clone()])).await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("oversized request was sent"),
        };
        assert!(matches!(error, ProviderError::RequestTooLarge { .. }));
        assert!(!error.is_retryable());
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
    handle.abort();
}

#[test]
fn resize_notice_names_only_images_that_lost_their_original_pixels() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.png");
    image::RgbImage::from_pixel(3200, 2400, image::Rgb([15, 100, 210]))
        .save(&big)
        .unwrap();
    let small = dir.path().join("small.png");
    image::RgbImage::from_pixel(120, 80, image::Rgb([15, 100, 210]))
        .save(&small)
        .unwrap();
    let preview = |path: &std::path::Path| ChatImage {
        path: path.to_string_lossy().into(),
        mime_type: "image/png".into(),
        detail: ImageDetail::Preview,
    };
    let mut user = ChatMessage::user("read this");
    user.images.push(preview(&big));
    user.images.push(preview(&small));

    let note = resize_notice(&request(vec![user])).expect("one image was reduced");
    assert!(note.starts_with("<image_resize_notice>"));
    assert!(note.contains("Image 1 of 2 was resized from 3200x2400 to"));
    assert!(!note.contains("Image 2 of 2"));
}

#[test]
fn untransformed_images_produce_no_resize_notice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("screen.png");
    image::RgbImage::from_pixel(3200, 2400, image::Rgb([12, 18, 37]))
        .save(&path)
        .unwrap();
    let mut user = ChatMessage::user("read this");
    user.images.push(image(&path));
    assert!(resize_notice(&request(vec![user])).is_none());
}
