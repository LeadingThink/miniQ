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
        capabilities: None,
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
    assert!(
        requests.try_recv().is_err(),
        "unexpected extra HTTP request"
    );
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
        json!({"model":"custom-video", "prompt":"山间的云", "duration":8, "resolution":"720p", "aspect_ratio":"16:9"}),
        "/v1/videos/generations",
        json!({"model":"custom-video", "prompt":"山间的云", "duration":8, "resolution":"720p", "aspect_ratio":"16:9"}),
    )
    .await;
}

#[tokio::test]
async fn h3_wire_body_maps_seconds_ratio_and_url_arrays_without_grok_fields() {
    for model in ["minimax-h3-768p", "minimax-h3-2k"] {
        for duration in [4, 15] {
            for ratio in ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] {
                let images = vec!["https://media.test/frame.png"; 5];
                let videos = vec!["https://media.test/clip.mp4"; 3];
                let audios = vec!["https://media.test/audio.mp3"; 3];
                assert_model_first_request(&GenerateVideoTool,
                    json!({"model":model,"prompt":"fixture", "duration":duration,"aspect_ratio":ratio,
                        "reference_images":images,"reference_videos":videos,"reference_audios":audios}),
                    "/v1/videos/std/generations",
                    json!({"model":model,"prompt":"fixture", "seconds":duration,"ratio":ratio,
                        "reference_images":images,"reference_videos":videos,"reference_audios":audios})).await;
            }
        }
    }
    assert_model_first_request(
        &GenerateVideoTool,
        json!({"model":"minimax-h3-768p","prompt":"fixture"}),
        "/v1/videos/std/generations",
        json!({"model":"minimax-h3-768p","prompt":"fixture","seconds":8}),
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
        video_model: "configured-video".into(),
        ..Default::default()
    });

    let error = GenerateVideoTool
        .execute(&ctx, json!({"prompt":"x", "image_path":"notes.txt"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("JPEG, PNG or WebP"));
}

#[tokio::test]
async fn music_http_body_starts_with_model_and_omits_absent_options() {
    assert_model_first_request(
        &GenerateMusicTool,
        json!({"prompt":"安静的钢琴曲", "instrumental":true}),
        "/v1/music/generations",
        json!({"model":"configured-music", "prompt":"安静的钢琴曲", "instrumental":true, "mode":"simple"}),
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
                "/v1/videos/std/generations/task_h3" => Json(json!({
                    "id":"task_h3", "status":status, "model":"minimax-h3-768p",
                    "video":{"url":"https://unrelated.invalid/never-follow-this"}
                }))
                .into_response(),
                "/v1/videos/std/generations/task_h3/content" => {
                    b"fake-h3-mp4".to_vec().into_response()
                }
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
async fn h3_video_query_uses_the_std_status_and_content_routes() {
    let (base_url, server) = video_status_server("completed").await;
    let directory = tempfile::tempdir().unwrap();
    let result = GetVideoGenerationTool
        .execute(
            &video_ctx(&directory, base_url),
            json!({"request_id":"task_h3", "model":"minimax-h3-768p"}),
        )
        .await
        .unwrap();
    server.abort();
    assert_eq!(result["resume"], false);
    let path = result["video"]["path"].as_str().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"fake-h3-mp4");
}

#[tokio::test]
async fn h3_query_preserves_model_and_stops_on_failed_status() {
    for (status, resume) in [("queued", true), ("in_progress", true), ("failed", false)] {
        let (base_url, server) = video_status_server(status).await;
        let directory = tempfile::tempdir().unwrap();
        let result = GetVideoGenerationTool
            .execute(
                &video_ctx(&directory, base_url),
                json!({"request_id":"task_h3", "model":"minimax-h3-768p"}),
            )
            .await
            .unwrap();
        server.abort();
        assert_eq!(result["resume"], resume);
        assert_eq!(result["request_id"], "task_h3");
        assert_eq!(result["model"], "minimax-h3-768p");
        assert!(result.get("video").is_none());
    }
}

#[tokio::test]
async fn h3_task_model_is_restored_across_contexts_without_resubmitting() {
    let app = Router::new().fallback(any(|uri: Uri| async move {
        use axum::response::IntoResponse;
        match uri.path() {
            "/v1/videos/std/generations" => {
                Json(json!({"id":"task_h3","status":"queued"})).into_response()
            }
            "/v1/videos/std/generations/task_h3" => {
                Json(json!({"id":"task_h3","status":"completed"})).into_response()
            }
            "/v1/videos/std/generations/task_h3/content" => {
                b"saved-model-video".to_vec().into_response()
            }
            _ => axum::http::StatusCode::NOT_FOUND.into_response(),
        }
    }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let mut ctx = video_ctx(&directory, base_url.clone());
    ctx.media.as_mut().unwrap().video_model = "minimax-h3-768p".into();
    let mut specs = vec![GenerateVideoTool.spec()];
    decorate_media_specs(ctx.media.as_ref().unwrap(), &mut specs);
    assert_eq!(
        specs[0].parameters["properties"]["model"]["default"],
        "minimax-h3-768p"
    );
    assert!(specs[0].parameters["allOf"][0]["if"]
        .get("required")
        .is_none());
    let generated = GenerateVideoTool
        .execute(&ctx, json!({"prompt":"fixture","duration":4}))
        .await
        .unwrap();
    assert_eq!(generated["request_id"], "task_h3");
    assert!(generated["metadata_error"].is_null());
    let fresh = video_ctx(&directory, base_url);
    assert!(matches!(
        GetVideoGenerationTool
            .execute(
                &fresh,
                json!({"request_id":"task_h3","model":"grok-imagine-video-1.5"})
            )
            .await,
        Err(ToolError::InvalidInput(_))
    ));
    let result = GetVideoGenerationTool
        .execute(&fresh, json!({"request_id":"task_h3"}))
        .await
        .unwrap();
    server.abort();
    assert_eq!(result["model"], "minimax-h3-768p");
    assert_eq!(result["resume"], false);
    assert_eq!(
        std::fs::read(result["video"]["path"].as_str().unwrap()).unwrap(),
        b"saved-model-video"
    );
    let changed_channel = video_ctx(&directory, "http://127.0.0.1:9/v1".into());
    assert!(matches!(
        GetVideoGenerationTool
            .execute(&changed_channel, json!({"request_id":"task_h3"}))
            .await,
        Err(ToolError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn grok_cross_origin_video_download_does_not_receive_provider_credentials() {
    let (sender, mut received) = mpsc::unbounded_channel();
    let download = Router::new().fallback(any(move |headers: axum::http::HeaderMap| {
        let sender = sender.clone();
        async move {
            sender.send(headers.get("authorization").cloned()).unwrap();
            b"external-video".to_vec()
        }
    }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let video_url = format!("http://{}/content", listener.local_addr().unwrap());
    let download_server =
        tokio::spawn(async move { axum::serve(listener, download).await.unwrap() });
    let status = Router::new().fallback(any(move || {
        let video_url = video_url.clone();
        async move { Json(json!({"status":"done", "video":{"url":video_url}})) }
    }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let status_server = tokio::spawn(async move { axum::serve(listener, status).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let result = GetVideoGenerationTool
        .execute(
            &video_ctx(&directory, base_url),
            json!({"request_id":"grok_external"}),
        )
        .await
        .unwrap();
    status_server.abort();
    download_server.abort();
    assert_eq!(result["resume"], false);
    assert!(received.recv().await.unwrap().is_none());
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

#[tokio::test]
async fn explicit_configured_models_have_the_same_wire_defaults_as_omitted_models() {
    let cases: Vec<(&dyn Tool, &str, &str, Value)> = vec![
        (
            &GenerateImageTool,
            "configured-image",
            "/v1/images/generations",
            json!({"model":"configured-image", "prompt":"fixture"}),
        ),
        (
            &GenerateVideoTool,
            "configured-video",
            "/v1/videos/generations",
            json!({"model":"configured-video", "prompt":"fixture"}),
        ),
        (
            &GenerateMusicTool,
            "configured-music",
            "/v1/music/generations",
            json!({"model":"configured-music", "prompt":"fixture", "instrumental":false, "mode":"simple"}),
        ),
    ];
    for (tool, model, endpoint, expected) in cases {
        assert_model_first_request(
            tool,
            json!({"prompt":"fixture"}),
            endpoint,
            expected.clone(),
        )
        .await;
        assert_model_first_request(
            tool,
            json!({"model":model, "prompt":"fixture"}),
            endpoint,
            expected,
        )
        .await;
    }
}

#[tokio::test]
async fn music_null_options_are_omitted_from_the_upstream_body() {
    assert_model_first_request(
        &GenerateMusicTool,
        json!({"prompt":"fixture", "mode":null, "style":null, "title":null,
            "negative_style":null, "vocal_gender":null, "style_weight":null, "weirdness":null}),
        "/v1/music/generations",
        json!({"model":"configured-music", "prompt":"fixture", "instrumental":false, "mode":"simple"}),
    )
    .await;
}

#[tokio::test]
async fn generic_gpt_image_model_preserves_size_and_quality_on_the_wire() {
    let input = json!({"model":"gpt-image-2.5-flare", "prompt":"海报",
        "size":"1024x1024", "quality":"high"});
    assert_model_first_request(
        &GenerateImageTool,
        input.clone(),
        "/v1/images/generations",
        input,
    )
    .await;
}

#[tokio::test]
async fn explicit_simple_music_mode_preserves_present_optional_strings() {
    assert_model_first_request(
        &GenerateMusicTool,
        json!({"prompt":"安静的钢琴曲", "mode":"simple",
            "style":"ambient piano", "title":"夜色", "negative_style":"heavy drums"}),
        "/v1/music/generations",
        json!({"model":"configured-music", "prompt":"安静的钢琴曲", "mode":"simple",
            "instrumental":false, "style":"ambient piano", "title":"夜色",
            "negative_style":"heavy drums"}),
    )
    .await;
}

#[tokio::test]
async fn custom_instrumental_music_accepts_omitted_or_empty_prompt() {
    for prompt in [None, Some(""), Some("   ")] {
        let mut input = json!({"mode":"custom", "instrumental":true,
            "style":"ambient piano", "title":"夜色"});
        if let Some(prompt) = prompt {
            input["prompt"] = prompt.into();
        }
        assert_model_first_request(
            &GenerateMusicTool,
            input,
            "/v1/music/generations",
            json!({"model":"configured-music", "prompt":"", "instrumental":true,
                "mode":"custom", "style":"ambient piano", "title":"夜色"}),
        )
        .await;
    }
}

#[tokio::test]
async fn custom_vocal_music_preserves_lyrics_and_optional_controls_at_both_bounds() {
    for (gender, weight, weirdness) in [("male", 0.0, 1.0), ("female", 1.0, 0.0)] {
        let input = json!({"model":"unknown-music", "prompt":"春风拂过\n山间花开",
            "mode":"custom", "instrumental":false, "style":"folk", "title":"春风",
            "negative_style":"heavy drums", "vocal_gender":gender,
            "style_weight":weight, "weirdness":weirdness});
        assert_model_first_request(
            &GenerateMusicTool,
            input.clone(),
            "/v1/music/generations",
            input,
        )
        .await;
    }
}

#[tokio::test]
async fn video_baseline_accepts_both_duration_bounds_resolutions_and_all_ratios() {
    for (index, ratio) in ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]
        .into_iter()
        .enumerate()
    {
        let input = json!({"model":"unknown-video", "prompt":"fixture",
            "duration":if index % 2 == 0 {1} else {15},
            "resolution":if index % 2 == 0 {"480p"} else {"720p"},
            "aspect_ratio":ratio});
        assert_model_first_request(
            &GenerateVideoTool,
            input.clone(),
            "/v1/videos/generations",
            input,
        )
        .await;
    }
}

#[tokio::test]
async fn video_multiple_references_preserve_order_and_detect_mime_from_bytes() {
    let (base_url, mut requests, server) = capture_requests().await;
    let directory = tempfile::tempdir().unwrap();
    let fixtures: [(&str, &str, &[u8]); 3] = [
        ("png.jpg", "image/png", b"\x89PNG\r\n\x1a\n"),
        ("jpeg.webp", "image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0]),
        ("webp.png", "image/webp", b"RIFF\x04\x00\x00\x00WEBP"),
    ];
    for (path, _, bytes) in fixtures {
        std::fs::write(directory.path().join(path), bytes).unwrap();
    }
    let ctx = video_ctx(&directory, base_url);
    for count in [1, 3, 7] {
        let selected: Vec<_> = fixtures.into_iter().cycle().take(count).collect();
        GenerateVideoTool
            .execute(
                &ctx,
                json!({"model":"explicit-video", "prompt":"animate",
                    "reference_images":selected.iter().map(|(path, _, _)| *path).collect::<Vec<_>>()}),
            )
            .await
            .unwrap();
        let (path, body) = requests.recv().await.unwrap();
        assert_eq!(path, "/v1/videos/generations");
        assert!(body.starts_with("{\"model\":"));
        let references: Vec<_> = selected
            .iter()
            .map(|(_, mime, bytes)| {
                json!({"url":format!("data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes))})
            })
            .collect();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"model":"explicit-video", "prompt":"animate",
                "reference_images":references})
        );
    }
    server.abort();
    assert!(requests.try_recv().is_err(), "unexpected metadata request");
}
