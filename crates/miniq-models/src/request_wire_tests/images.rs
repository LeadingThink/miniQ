//! A visible image must identify the exact local bytes tools can process.
use super::*;
use crate::{ChatImage, ImageDetail};
use base64::Engine;

async fn capture_images(protocol: ApiProtocol, messages: Vec<ChatMessage>) -> Value {
    let captured = Arc::new(Mutex::new(None));
    let handler_capture = captured.clone();
    let router = Router::new().route(
        "/v1/{*path}",
        post(move |bytes: Bytes| async move {
            *handler_capture.lock().unwrap() =
                Some(serde_json::from_slice::<Value>(&bytes).unwrap());
            ([("content-type", "text/event-stream")], response(protocol))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = ProviderConfig {
        base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
        api_key: "test-key".into(),
        model: "test-vision".into(),
        api_protocol: protocol,
        reasoning_effort: None,
    };
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider: Box<dyn ModelProvider> = match protocol {
        ApiProtocol::Responses => Box::new(ResponsesProvider::new(config)),
        ApiProtocol::ChatCompletions => Box::new(OpenAiCompatProvider::new(config)),
        ApiProtocol::AnthropicMessages => Box::new(AnthropicProvider::new(config)),
        ApiProtocol::Auto => unreachable!(),
    };
    provider
        .stream_complete(CompletionRequest {
            context_compact_threshold: None,
            trace: Default::default(),
            messages,
            tools: vec![],
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    server.abort();
    let body = captured.lock().unwrap().take().unwrap();
    body
}

#[tokio::test]
async fn all_protocols_bind_each_user_image_to_its_original_file() {
    let directory = tempfile::tempdir().unwrap();
    let mut user = ChatMessage::user("把第二张图片切成九宫格");
    let mut originals = Vec::new();
    for (index, color) in [[255, 0, 0], [0, 255, 0]].into_iter().enumerate() {
        let folder = directory.path().join(format!("附件 {index}"));
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("同名图片.png");
        image::RgbImage::from_pixel(6, 9, image::Rgb(color))
            .save(&path)
            .unwrap();
        originals.push(std::fs::read(&path).unwrap());
        user.images.push(ChatImage {
            path: path.to_string_lossy().into(),
            mime_type: "image/png".into(),
            detail: ImageDetail::Auto,
        });
    }
    for protocol in [
        ApiProtocol::Responses,
        ApiProtocol::ChatCompletions,
        ApiProtocol::AnthropicMessages,
    ] {
        // Restore from the stored representation as a later turn would.
        let restored = serde_json::from_value(serde_json::to_value(&user).unwrap()).unwrap();
        let body = capture_images(protocol, vec![restored]).await;
        let parts = if protocol == ApiProtocol::Responses {
            &body["input"][0]["content"]
        } else {
            &body["messages"][0]["content"]
        };
        let parts = parts.as_array().unwrap();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0]["text"], user.content);
        for (index, image) in user.images.iter().enumerate() {
            let label = parts[1 + index * 2]["text"].as_str().unwrap();
            assert!(label.starts_with(&format!("Image #{} local file", index + 1)));
            let (_, metadata) = label.split_once(": ").unwrap();
            let source: Value = serde_json::from_str(metadata).unwrap();
            assert_eq!(source["path"], image.path);
            assert_eq!(source["mimeType"], image.mime_type);
            let pixels = &parts[2 + index * 2];
            let base64 = match protocol {
                ApiProtocol::Responses => {
                    pixels["image_url"]
                        .as_str()
                        .unwrap()
                        .split_once(',')
                        .unwrap()
                        .1
                }
                ApiProtocol::ChatCompletions => {
                    pixels["image_url"]["url"]
                        .as_str()
                        .unwrap()
                        .split_once(',')
                        .unwrap()
                        .1
                }
                ApiProtocol::AnthropicMessages => pixels["source"]["data"].as_str().unwrap(),
                ApiProtocol::Auto => unreachable!(),
            };
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(base64)
                    .unwrap(),
                originals[index]
            );
            assert_eq!(
                std::fs::read(source["path"].as_str().unwrap()).unwrap(),
                originals[index]
            );
        }
    }
}
