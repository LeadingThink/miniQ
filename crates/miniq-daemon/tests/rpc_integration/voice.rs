use super::*;
use axum::{extract::Request, http::StatusCode, response::IntoResponse, routing::post, Router};
use base64::Engine;
use miniq_daemon::state::DaemonSettings;
use miniq_models::ProviderConfig;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

async fn voice_daemon(api: Router) -> (WsClient, tempfile::TempDir) {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = upstream.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(upstream, api).await.unwrap() });
    let settings = DaemonSettings {
        provider: Some(ProviderConfig {
            base_url: format!("http://{address}/v1"),
            api_key: "test-secret".into(),
            model: "chat-model".into(),
            api_protocol: miniq_models::ApiProtocol::ChatCompletions,
            reasoning_effort: None,
        }),
        ..DaemonSettings::default()
    };
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::with_settings(
        Store::open_in_memory().unwrap(),
        "voice-token".into(),
        settings,
        dir.path().join("settings.json"),
    );
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { server::serve(listener, state).await.unwrap() });
    (connect(port, "voice-token").await, dir)
}

fn audio(preview: bool) -> Value {
    json!({"audioBase64": base64::engine::general_purpose::STANDARD.encode([0_u8; 45]), "filename": "record.wav", "preview": preview})
}

#[tokio::test]
async fn recognition_uses_configured_provider_without_blocking_connection() {
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (entered, proceed) = (started.clone(), release.clone());
    let api = Router::new().route(
        "/v1/audio/transcriptions",
        post(move |request: Request| {
            let (entered, proceed) = (entered.clone(), proceed.clone());
            async move {
                assert_eq!(
                    request.headers().get("authorization").unwrap(),
                    "Bearer test-secret"
                );
                let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
                    .await
                    .unwrap();
                let body = String::from_utf8_lossy(&bytes);
                assert!(body.contains("grok-transcribe"));
                assert!(body.contains("record.wav"));
                assert!(!body.contains("name=\"preview\""));
                assert!(!body.contains("name=\"stream\""));
                entered.notify_one();
                proceed.notified().await;
                axum::Json(json!({"text": "转写成功"}))
            }
        }),
    );
    let (mut ws, _dir) = voice_daemon(api).await;
    ws.send(Message::Text(
        json!({"jsonrpc":"2.0", "id":"speech", "method":"voice.transcribe", "params":audio(true)})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), started.notified())
        .await
        .unwrap();
    let health = tokio::time::timeout(
        Duration::from_secs(2),
        call(&mut ws, "health", "daemon.health", Value::Null),
    )
    .await
    .expect("recognition must not block health");
    assert_eq!(health["result"]["protocolVersion"], 2);
    release.notify_one();
    let response = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = response else {
        panic!("expected RPC response")
    };
    let response: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(response["id"], "speech");
    assert_eq!(response["result"]["text"], "转写成功");
}

#[tokio::test]
async fn silence_is_a_valid_preview_but_not_a_final_transcript() {
    let api = Router::new().route(
        "/v1/audio/transcriptions",
        post(|| async { axum::Json(json!({"text":"  "})) }),
    );
    let (mut ws, _dir) = voice_daemon(api).await;
    assert_eq!(
        call(&mut ws, "preview", "voice.transcribe", audio(true)).await["result"]["text"],
        ""
    );
    assert!(
        call(&mut ws, "final", "voice.transcribe", audio(false)).await["error"]["message"]
            .as_str()
            .unwrap()
            .contains("empty text")
    );
}

#[tokio::test]
async fn previews_fail_fast_while_final_requests_retry_temporary_errors() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let api = Router::new().route(
        "/v1/audio/transcriptions",
        post(move || {
            let count = count.clone();
            async move {
                if count.fetch_add(1, Ordering::SeqCst) < 3 {
                    (StatusCode::SERVICE_UNAVAILABLE, "temporarily overloaded").into_response()
                } else {
                    axum::Json(json!({"text":"恢复成功"})).into_response()
                }
            }
        }),
    );
    let (mut ws, _dir) = voice_daemon(api).await;
    assert!(call(&mut ws, "preview", "voice.transcribe", audio(true)).await["error"].is_object());
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let response = call(&mut ws, "final", "voice.transcribe", audio(false)).await;
    assert_eq!(response["result"]["text"], "恢复成功");
    assert_eq!(requests.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn capabilities_reflects_audio_models_in_catalog() {
    use axum::routing::get as route;
    let api = Router::new().route(
        "/v1/models",
        route(|| async {
            axum::Json(json!({"data":[
              {"id":"chat-model","model_type":"chat"},
              {"id":"grok-transcribe"},
              {"id":"grok-tts"},
            ]}))
        }),
    );
    let (mut ws, _dir) = voice_daemon(api).await;
    let response = call(&mut ws, "caps", "voice.capabilities", Value::Null).await;
    assert_eq!(response["result"]["transcribe"], true);
    assert_eq!(response["result"]["speak"], true);
    assert_eq!(response["result"]["transcribeModel"], "grok-transcribe");
    assert_eq!(response["result"]["ttsModel"], "grok-tts");
}

#[tokio::test]
async fn capabilities_hides_buttons_when_audio_models_absent() {
    use axum::routing::get as route;
    let api = Router::new().route(
        "/v1/models",
        route(|| async { axum::Json(json!({"data":[{"id":"chat-model","model_type":"chat"}]})) }),
    );
    let (mut ws, _dir) = voice_daemon(api).await;
    let response = call(&mut ws, "caps", "voice.capabilities", Value::Null).await;
    assert_eq!(response["result"]["transcribe"], false);
    assert_eq!(response["result"]["speak"], false);
    assert!(response["result"]["transcribeModel"].is_null());
    assert!(response["result"]["ttsModel"].is_null());
}

#[tokio::test]
async fn speak_synthesizes_with_grok_tts_defaults() {
    let api = Router::new().route(
        "/v1/audio/speech",
        post(|request: Request| async move {
            assert_eq!(
                request.headers().get("authorization").unwrap(),
                "Bearer test-secret"
            );
            let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["model"], "grok-tts");
            assert_eq!(body["input"], "你好，欢迎使用在问。");
            assert_eq!(body["voice"], "eve");
            assert_eq!(body["response_format"], "mp3");
            assert_eq!(body["speed"], 1.0);
            (
                [(axum::http::header::CONTENT_TYPE, "audio/mpeg")],
                b"fake-mp3-bytes".to_vec(),
            )
        }),
    );
    let (mut ws, _dir) = voice_daemon(api).await;
    let response = call(
        &mut ws,
        "speak",
        "voice.speak",
        json!({"text": "你好，欢迎使用在问。"}),
    )
    .await;
    let audio = base64::engine::general_purpose::STANDARD
        .decode(response["result"]["audioBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(audio, b"fake-mp3-bytes");
    assert_eq!(response["result"]["mimeType"], "audio/mpeg");
    assert_eq!(response["result"]["voice"], "eve");
}

#[tokio::test]
async fn speak_rejects_empty_text_and_bad_voice() {
    let (mut ws, _dir) = voice_daemon(Router::new()).await;
    assert!(
        call(&mut ws, "empty", "voice.speak", json!({"text": "  "})).await["error"].is_object()
    );
    assert!(call(
        &mut ws,
        "voice",
        "voice.speak",
        json!({"text": "hi", "voice": "unknown"})
    )
    .await["error"]
        .is_object());
    assert!(call(
        &mut ws,
        "format",
        "voice.speak",
        json!({"text": "hi", "responseFormat": "ogg"}),
    )
    .await["error"]
        .is_object());
    let long = "你".repeat(1600);
    assert!(call(&mut ws, "long", "voice.speak", json!({"text": long})).await["error"].is_object());
}
