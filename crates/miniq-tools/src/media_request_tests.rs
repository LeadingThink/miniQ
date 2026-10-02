use super::*;
use axum::{http::Uri, routing::any, Json, Router};
use tokio::sync::mpsc;

async fn capture_requests() -> (
    String,
    mpsc::UnboundedReceiver<(String, String)>,
    tokio::task::JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let app = Router::new().fallback(any(move |uri: Uri, body: String| {
        let sender = sender.clone();
        async move {
            let request_target = match uri.query() {
                Some(query) => format!("{}?{query}", uri.path()),
                None => uri.path().to_owned(),
            };
            sender.send((request_target, body)).unwrap();
            Json(json!({"id":"fixture-task", "data":[{"url":"https://media.test/image.png"}]}))
        }
    }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1"), receiver, server)
}

async fn assert_model_first_request(
    tool: &dyn Tool,
    input: Value,
    endpoint: &str,
    expected: Value,
) {
    let (base_url, mut requests, server) = capture_requests().await;
    let directory = tempfile::tempdir().unwrap();
    let mut ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.media = Some(MediaConfig {
        base_url,
        api_key: "test-key".into(),
        image_model: "configured-image".into(),
        video_model: "configured-video".into(),
        tts_model: "configured-speech".into(),
        music_model: "configured-music".into(),
        ..Default::default()
    });
    let result = tool.execute(&ctx, input).await;
    server.abort();
    result.unwrap();
    let (path, body) = requests.recv().await.unwrap();
    assert_eq!(path, endpoint);
    assert!(
        body.starts_with("{\"model\":"),
        "model must be the first root key: {body}"
    );
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), expected);
}

#[tokio::test]
async fn image_http_body_starts_with_model_and_preserves_options() {
    assert_model_first_request(
        &GenerateImageTool,
        json!({"prompt":"海报：中文，保留完整内容。", "size":"1024x1024", "quality":"high"}),
        "/v1/images/generations",
        json!({"model":"configured-image", "prompt":"海报：中文，保留完整内容。", "size":"1024x1024", "quality":"high"}),
    )
    .await;
}

#[tokio::test]
async fn speech_http_body_starts_with_model_before_input() {
    assert_model_first_request(
        &SynthesizeSpeechTool,
        json!({"input":"你好，世界。", "voice":"eve", "response_format":"wav"}),
        "/v1/audio/speech",
        json!({"model":"configured-speech", "input":"你好，世界。", "voice":"eve", "response_format":"wav"}),
    )
    .await;
}

#[tokio::test]
async fn video_http_body_starts_with_model_before_aspect_ratio_and_duration() {
    assert_model_first_request(
        &GenerateVideoTool,
        json!({"model":"custom-video", "prompt":"山间的云", "duration":8, "resolution":"1080p", "aspect_ratio":"16:9"}),
        "/v1/videos/generations",
        json!({"model":"custom-video", "prompt":"山间的云", "duration":8, "resolution":"1080p", "aspect_ratio":"16:9"}),
    )
    .await;
}

#[tokio::test]
async fn video_reference_image_is_sent_as_url_object_with_detected_mime() {
    let (base_url, mut requests, server) = capture_requests().await;
    let directory = tempfile::tempdir().unwrap();
    let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    std::fs::write(directory.path().join("frame.jpg"), jpeg).unwrap();
    let mut ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.media = Some(MediaConfig {
        base_url,
        api_key: "test-key".into(),
        video_model: "configured-video".into(),
        ..Default::default()
    });

    GenerateVideoTool
        .execute(
            &ctx,
            json!({"prompt":"让画面动起来", "image_path":"frame.jpg"}),
        )
        .await
        .unwrap();
    server.abort();

    let (path, body) = requests.recv().await.unwrap();
    assert_eq!(path, "/v1/videos/generations");
    let body: Value = serde_json::from_str(&body).unwrap();
    let expected = format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    );
    assert_eq!(body["image"], json!({"url": expected}));
}

#[tokio::test]
async fn video_reference_rejects_non_image_files_before_requesting() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("notes.txt"), "plain text").unwrap();
    let mut ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.media = Some(MediaConfig {
        base_url: "http://127.0.0.1:9/v1".into(),
        api_key: "test-key".into(),
        ..Default::default()
    });

    let error = GenerateVideoTool
        .execute(&ctx, json!({"prompt":"x", "image_path":"notes.txt"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("JPEG, PNG or WebP"));
}

#[tokio::test]
async fn music_http_body_starts_with_model_before_instrumental_and_keeps_nulls() {
    assert_model_first_request(
        &GenerateMusicTool,
        json!({"prompt":"安静的钢琴曲", "instrumental":true}),
        "/v1/music/generations",
        json!({"model":"configured-music", "prompt":"安静的钢琴曲", "instrumental":true, "style":null, "title":null}),
    )
    .await;
}

#[tokio::test]
async fn music_clip_query_uses_clip_id_path_and_returns_clip() {
    let (base_url, mut requests, server) = capture_requests().await;
    let directory = tempfile::tempdir().unwrap();
    let mut ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.media = Some(MediaConfig {
        base_url,
        api_key: "test-key".into(),
        music_model: "configured-music".into(),
        ..Default::default()
    });

    let result = GetMusicGenerationTool
        .execute(&ctx, json!({"clip_id":"clip-123"}))
        .await
        .unwrap();
    server.abort();

    let (path, body) = requests.recv().await.unwrap();
    assert_eq!(path, "/v1/music/clips/clip-123");
    assert!(body.is_empty());
    assert_eq!(result["kind"], "music_task");
    assert_eq!(result["task"]["id"], "fixture-task");
}

#[tokio::test]
async fn music_clips_query_uses_comma_separated_ids() {
    let (base_url, mut requests, server) = capture_requests().await;
    let directory = tempfile::tempdir().unwrap();
    let mut ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.media = Some(MediaConfig {
        base_url,
        api_key: "test-key".into(),
        music_model: "configured-music".into(),
        ..Default::default()
    });

    let result = GetMusicClipsTool
        .execute(&ctx, json!({"clip_ids":["clip-123", "clip-456"]}))
        .await
        .unwrap();
    server.abort();

    let (path, body) = requests.recv().await.unwrap();
    assert_eq!(path, "/v1/music/clips?ids=clip-123,clip-456");
    assert!(body.is_empty());
    assert_eq!(result["kind"], "music_task");
}

async fn video_status_server(status: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().fallback(any(
        move |uri: Uri, headers: axum::http::HeaderMap| async move {
            use axum::response::IntoResponse;
            let authorized = headers.get("authorization").and_then(|v| v.to_str().ok())
                == Some("Bearer test-key");
            if !authorized {
                return axum::http::StatusCode::UNAUTHORIZED.into_response();
            }
            match uri.path() {
                "/v1/videos/video_abc" => Json(json!({
                    "request_id":"video_abc",
                    "status":status,
                    "video":{"url":"/v1/videos/video_abc/content","duration":5.0}
                }))
                .into_response(),
                "/v1/videos/video_abc/content" => b"fake-mp4".to_vec().into_response(),
                _ => axum::http::StatusCode::NOT_FOUND.into_response(),
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1"), server)
}

fn video_ctx(directory: &tempfile::TempDir, base_url: String) -> ToolContext {
    let mut ctx = ToolContext::new(directory.path().to_path_buf());
    ctx.media = Some(MediaConfig {
        base_url,
        api_key: "test-key".into(),
        ..Default::default()
    });
    ctx
}

#[tokio::test]
async fn video_query_returns_pending_task_without_downloading() {
    let (base_url, server) = video_status_server("pending").await;
    let directory = tempfile::tempdir().unwrap();
    let result = GetVideoGenerationTool
        .execute(
            &video_ctx(&directory, base_url),
            json!({"request_id":"video_abc"}),
        )
        .await
        .unwrap();
    server.abort();
    assert_eq!(result["kind"], "video_task");
    assert_eq!(result["resume"], true);
    assert!(result.get("video").is_none());
}

#[tokio::test]
async fn video_query_downloads_finished_video_with_provider_auth() {
    let (base_url, server) = video_status_server("done").await;
    let directory = tempfile::tempdir().unwrap();
    let result = GetVideoGenerationTool
        .execute(
            &video_ctx(&directory, base_url),
            json!({"request_id":"video_abc"}),
        )
        .await
        .unwrap();
    server.abort();
    assert_eq!(result["resume"], false);
    assert_eq!(result["video"]["mimeType"], "video/mp4");
    let path = result["video"]["path"].as_str().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"fake-mp4");
}

#[tokio::test]
async fn video_query_rejects_path_traversal_ids() {
    let directory = tempfile::tempdir().unwrap();
    let error = GetVideoGenerationTool
        .execute(
            &video_ctx(&directory, "http://127.0.0.1:9/v1".into()),
            json!({"request_id":"../secrets"}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("request_id"));
}
