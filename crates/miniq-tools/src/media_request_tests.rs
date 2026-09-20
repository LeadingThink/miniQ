use super::*;
use axum::{http::Uri, routing::post, Json, Router};
use tokio::sync::mpsc;

async fn capture_requests() -> (
    String,
    mpsc::UnboundedReceiver<(String, String)>,
    tokio::task::JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let app = Router::new().fallback(post(move |uri: Uri, body: String| {
        let sender = sender.clone();
        async move {
            sender.send((uri.path().to_owned(), body)).unwrap();
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
async fn music_http_body_starts_with_model_before_instrumental_and_keeps_nulls() {
    assert_model_first_request(
        &GenerateMusicTool,
        json!({"prompt":"安静的钢琴曲", "instrumental":true}),
        "/v1/music/generations",
        json!({"model":"configured-music", "prompt":"安静的钢琴曲", "instrumental":true, "style":null, "title":null}),
    )
    .await;
}
