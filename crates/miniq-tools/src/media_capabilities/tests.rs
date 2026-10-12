use super::*;

use axum::{extract::State, http::StatusCode, routing::any, Json, Router};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tempfile::TempDir;

#[derive(Clone, Default)]
struct FakeState {
    details_calls: Arc<AtomicUsize>,
    page_calls: Arc<AtomicUsize>,
    mode: Arc<AtomicUsize>,
}

async fn fake_handler(
    State(state): State<FakeState>,
    request: axum::extract::Request,
) -> (StatusCode, Json<Value>) {
    let path = request.uri().path();
    if path.ends_with("/models/details") {
        state.details_calls.fetch_add(1, Ordering::SeqCst);
        if state.mode.load(Ordering::SeqCst) == 2 {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":{"message":"bad secret-shaped text","code":"server"}})),
            );
        }
        if state.mode.load(Ordering::SeqCst) == 3 {
            return (
                StatusCode::OK,
                Json(json!({"code":"-1", "data":{"models":[],"total":0}})),
            );
        }
        let query = request.uri().query().unwrap_or_default();
        let page = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("page=")?.parse::<usize>().ok())
            .unwrap_or(1);
        state.page_calls.fetch_add(1, Ordering::SeqCst);
        let suffix = if state.mode.load(Ordering::SeqCst) == 1 {
            "new"
        } else {
            "old"
        };
        let models = if page == 1 {
            let mut models = (0..100)
                .map(|n| json!({"model_id": format!("image-{n}-{suffix}"), "model_type":"image"}))
                .collect::<Vec<_>>();
            models.push(json!({"model_id": format!("video-{suffix}"), "model_type":"video", "max_duration": if suffix == "new" { 9 } else { 15 }}));
            models.push(json!({"model_id": format!("music-{suffix}"), "model_type":"audio_gen"}));
            models
        } else {
            vec![json!({"model_id": format!("image-100-{suffix}"), "model_type":"image"})]
        };
        return (
            StatusCode::OK,
            Json(json!({"data":{"models":models,"total":103,"page":page,"page_size":100}})),
        );
    }
    if path.ends_with("/openapi.json") {
        return (StatusCode::OK, Json(json!({"openapi":"3.0.0","paths":{}})));
    }
    (StatusCode::NOT_FOUND, Json(json!({"error":"missing"})))
}

async fn server(state: FakeState) -> String {
    let app = Router::new().fallback(any(fake_handler)).with_state(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}/v1")
}

fn media(base_url: String) -> crate::MediaConfig {
    crate::MediaConfig {
        base_url,
        api_key: "do-not-persist-this-token".into(),
        image_model: "image-default".into(),
        video_model: "video-default".into(),
        tts_model: "tts-default".into(),
        transcription_model: "stt-default".into(),
        music_model: "music-default".into(),
        capabilities: None,
    }
}

#[tokio::test]
async fn daily_ttl_allows_fresh_snapshot_and_refreshes_after_explicit_time() {
    let _guard = test_guard();
    set_test_now(10_000);
    let state = FakeState::default();
    let base_url = server(state.clone()).await;
    let registry = MediaCapabilityRegistry::new(None);
    let first = registry
        .refresh_due(&media(base_url.clone()))
        .await
        .unwrap();
    assert_eq!(first.fetched_at, 10_000);
    let calls = state.details_calls.load(Ordering::SeqCst);
    set_test_now(10_000 + MEDIA_REFRESH_INTERVAL_SECS - 1);
    assert!(Arc::ptr_eq(
        &first,
        &registry
            .refresh_due(&media(base_url.clone()))
            .await
            .unwrap()
    ));
    assert_eq!(calls, state.details_calls.load(Ordering::SeqCst));
    set_test_now(10_000 + MEDIA_REFRESH_INTERVAL_SECS);
    let second = registry.refresh_due(&media(base_url)).await.unwrap();
    assert!(second.fetched_at > first.fetched_at);
}

#[tokio::test]
async fn concurrent_same_channel_refresh_is_deduplicated() {
    let _guard = test_guard();
    set_test_now(20_000);
    let state = FakeState::default();
    let base_url = server(state.clone()).await;
    let registry = Arc::new(MediaCapabilityRegistry::new(None));
    let config = media(base_url);
    let (a, b) = tokio::join!(registry.refresh_due(&config), registry.refresh_due(&config));
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(state.details_calls.load(Ordering::SeqCst), 6);
    assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
}

#[tokio::test]
async fn pagination_covers_more_than_one_hundred_models() {
    let _guard = test_guard();
    set_test_now(30_000);
    let state = FakeState::default();
    let base_url = server(state.clone()).await;
    let snapshot = MediaCapabilityRegistry::new(None)
        .refresh_due(&media(base_url))
        .await
        .unwrap();
    assert_eq!(
        snapshot
            .models
            .iter()
            .filter(|model| model.kind == "image")
            .count(),
        101
    );
    assert!(state.page_calls.load(Ordering::SeqCst) >= 6);
}

#[tokio::test]
async fn refresh_updates_model_directory_and_selected_model_ranges() {
    let _guard = test_guard();
    set_test_now(35_000);
    let state = FakeState::default();
    let base_url = server(state.clone()).await;
    let registry = MediaCapabilityRegistry::new(None);
    let first = registry
        .refresh_due(&media(base_url.clone()))
        .await
        .unwrap();
    state.mode.store(1, Ordering::SeqCst);
    set_test_now(35_000 + MEDIA_REFRESH_INTERVAL_SECS);
    let second = registry.refresh_due(&media(base_url)).await.unwrap();
    assert!(first.models.iter().any(|model| model.id == "music-old"));
    assert!(second.models.iter().any(|model| model.id == "music-new"));
    assert_eq!(
        first
            .models
            .iter()
            .find(|model| model.kind == "video")
            .unwrap()
            .max_duration,
        Some(15)
    );
    assert_eq!(
        second
            .models
            .iter()
            .find(|model| model.kind == "video")
            .unwrap()
            .max_duration,
        Some(9)
    );
}

#[tokio::test]
async fn failed_refresh_keeps_stale_snapshot_and_does_not_persist_error_payload() {
    let _guard = test_guard();
    set_test_now(40_000);
    let state = FakeState::default();
    let base_url = server(state.clone()).await;
    let registry = MediaCapabilityRegistry::new(None);
    let old = registry
        .refresh_due(&media(base_url.clone()))
        .await
        .unwrap();
    {
        // Published data remains readable while a refresh owns the async lock.
        let channel = registry.channel(&base_url);
        let _refresh = channel.state.lock().await;
        assert!(Arc::ptr_eq(&registry.snapshot(&base_url).unwrap(), &old));
    }
    state.mode.store(2, Ordering::SeqCst);
    set_test_now(40_000 + MEDIA_REFRESH_INTERVAL_SECS);
    let error = registry
        .refresh_due(&media(base_url.clone()))
        .await
        .unwrap_err();
    assert!(error.contains("status=500") && error.contains("code=-1"));
    assert!(!error.contains("do-not-persist-this-token"));
    let current = registry
        .snapshot(&base_url)
        .expect("stale snapshot retained");
    assert_eq!(current.fetched_at, old.fetched_at);
    state.mode.store(3, Ordering::SeqCst);
    set_test_now(40_000 + MEDIA_REFRESH_INTERVAL_SECS + 3600);
    assert!(registry
        .refresh_due(&media(base_url.clone()))
        .await
        .is_err());
    assert_eq!(
        registry.snapshot(&base_url).unwrap().fetched_at,
        old.fetched_at
    );
}

#[tokio::test]
async fn cache_survives_registry_restart_without_secret() {
    let _guard = test_guard();
    set_test_now(50_000);
    let state = FakeState::default();
    let base_url = server(state.clone()).await;
    let directory = TempDir::new().unwrap();
    let first = MediaCapabilityRegistry::new(Some(directory.path().to_path_buf()))
        .refresh_due(&media(base_url.clone()))
        .await
        .unwrap();
    drop(first);
    let restarted = MediaCapabilityRegistry::new(Some(directory.path().to_path_buf()));
    let cached = restarted.snapshot(&base_url).unwrap();
    assert_eq!(cached.models.len(), 103);
    let bytes = std::fs::read_dir(directory.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let text = std::fs::read_to_string(bytes).unwrap();
    assert!(!text.contains("do-not-persist-this-token"));
}

#[tokio::test]
async fn channels_are_isolated() {
    let _guard = test_guard();
    set_test_now(60_000);
    let first_state = FakeState::default();
    let second_state = FakeState::default();
    let first_url = server(first_state).await;
    let second_url = server(second_state).await;
    let registry = MediaCapabilityRegistry::new(None);
    let first = registry
        .refresh_due(&media(first_url.clone()))
        .await
        .unwrap();
    let second = registry
        .refresh_due(&media(second_url.clone()))
        .await
        .unwrap();
    assert_ne!(first.base_url, second.base_url);
    assert!(registry.snapshot(&first_url).is_some());
    assert!(registry.snapshot(&second_url).is_some());
}

#[test]
fn normalization_drops_unsupported_and_secret_fields() {
    let _guard = test_guard();
    let schema = normalize_tool_schema(
        "generate_image",
        &json!({"type":"object","additionalProperties":true,"properties":{
            "prompt":{"type":"string"},"model":{"type":"string"},"api_key":{"type":"string"},
            "size":{"type":"string"},"quality":{"type":"string"},"admin":{"type":"string"}
        }}),
    );
    assert_eq!(schema["additionalProperties"], false);
    assert!(schema["properties"].get("prompt").is_some());
    assert!(schema["properties"].get("api_key").is_none());
    assert!(schema["properties"].get("admin").is_none());
}

#[test]
fn model_selection_respects_explicit_and_prefers_suno_then_sorted_fallback() {
    let _guard = test_guard();
    let snapshot = MediaCapabilitySnapshot {
        base_url: "https://example.test/v1".into(),
        fetched_at: 1,
        models: vec![
            MediaModel {
                id: "zeta".into(),
                kind: "music".into(),
                max_duration: None,
                route: None,
                metadata: BTreeMap::new(),
                schemas: BTreeMap::new(),
            },
            MediaModel {
                id: "suno-v6".into(),
                kind: "music".into(),
                max_duration: None,
                route: None,
                metadata: BTreeMap::new(),
                schemas: BTreeMap::new(),
            },
        ],
        schemas: BTreeMap::new(),
        sources: Vec::new(),
        partial: false,
    };
    assert_eq!(
        snapshot.select_model("music", "missing", None).unwrap(),
        "suno-v6"
    );
    assert_eq!(
        snapshot
            .select_model("music", "missing", Some("zeta"))
            .unwrap(),
        "zeta"
    );
    assert!(snapshot
        .select_model("image", "missing", Some("zeta"))
        .is_err());
}

#[tokio::test]
async fn changing_credentials_refreshes_and_clears_backoff_without_persisting_keys() {
    let _guard = test_guard();
    set_test_now(90_000);
    let state = FakeState::default();
    let base_url = server(state.clone()).await;
    let registry = MediaCapabilityRegistry::new(None);
    let mut config = media(base_url);
    config.api_key = "credential-before".into();
    registry.refresh_due(&config).await.unwrap();
    let initial = state.details_calls.load(Ordering::SeqCst);
    state.mode.store(1, Ordering::SeqCst);
    config.api_key = "credential-after".into();
    let fresh = registry.refresh_due(&config).await.unwrap();
    assert!(fresh.models.iter().any(|model| model.id == "music-new"));
    assert!(state.details_calls.load(Ordering::SeqCst) > initial);
    assert!(!serde_json::to_string(fresh.as_ref())
        .unwrap()
        .contains("credential-"));
    state.mode.store(2, Ordering::SeqCst);
    set_test_now(90_000 + MEDIA_REFRESH_INTERVAL_SECS);
    assert!(registry.refresh_due(&config).await.is_err());
    state.mode.store(0, Ordering::SeqCst);
    config.api_key = "new-working-credential".into();
    assert!(registry.refresh_due(&config).await.is_ok());
}
