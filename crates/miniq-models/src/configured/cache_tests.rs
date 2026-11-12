use super::*;
use axum::{http::StatusCode, routing::get, Json, Router};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn config(base_url: String) -> ProviderConfig {
    ProviderConfig {
        base_url,
        api_key: "test-account".into(),
        model: "test-model".into(),
        api_protocol: ApiProtocol::Auto,
        reasoning_effort: None,
    }
}

#[tokio::test]
async fn simultaneous_metadata_requests_share_one_fetch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let server_calls = calls.clone();
    let app = Router::new().route(
        "/v1/models/{model}",
        get(move || {
            let calls = server_calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Json(serde_json::json!({"data": {
                    "preferred_api_protocol": "responses",
                    "max_tokens": 200000,
                    "supported_reasoning_efforts": ["low", "high"]
                }}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let provider = ConfiguredProvider::new(config(format!("http://{address}/v1")));
    let results = futures_util::future::join_all((0..16).map(|_| provider.capabilities())).await;
    assert!(results
        .iter()
        .all(|result| result.max_context_tokens == Some(200000)));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.capabilities.get().unwrap().ttl, METADATA_TTL);
    assert!(provider.is_cache_fresh());
    server.abort();
}

#[tokio::test]
async fn unavailable_metadata_is_shared_but_expires_quickly_for_next_turn() {
    let calls = Arc::new(AtomicUsize::new(0));
    let server_calls = calls.clone();
    let app = Router::new().route(
        "/v1/models/{model}",
        get(move || {
            let calls = server_calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                StatusCode::SERVICE_UNAVAILABLE
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut provider = ConfiguredProvider::new(config(format!("http://{address}/v1")));
    let first = provider.capabilities().await;
    let second = provider.capabilities().await;
    assert_eq!(first, ModelCapabilities::default());
    assert_eq!(first, second);
    // One detail request and one catalog request, both cached for this task.
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        provider.capabilities.get().unwrap().ttl,
        INCOMPLETE_METADATA_TTL
    );
    assert!(provider.is_cache_fresh());
    provider.capabilities.get_mut().unwrap().fetched_at = Instant::now() - INCOMPLETE_METADATA_TTL;
    assert!(!provider.is_cache_fresh());
    // Expiration is advisory at a turn boundary. An already running task keeps
    // its original metadata and avoids changing protocol mid-task.
    assert_eq!(provider.capabilities().await, first);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.abort();
}

#[test]
fn successful_metadata_also_has_a_finite_lifetime() {
    let mut provider = ConfiguredProvider::new(config("https://provider.test/v1".into()));
    provider
        .capabilities
        .set(CapabilitySnapshot {
            value: ModelCapabilities::default(),
            fetched_at: Instant::now(),
            ttl: METADATA_TTL,
        })
        .ok()
        .unwrap();
    assert!(provider.is_cache_fresh());
    provider.capabilities.get_mut().unwrap().fetched_at = Instant::now() - METADATA_TTL;
    assert!(!provider.is_cache_fresh());
}
