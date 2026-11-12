use super::*;
use miniq_protocol::{ApiProtocol, ReasoningEffort};

fn config(model: &str) -> ProviderConfig {
    ProviderConfig {
        base_url: "https://provider.test/v1".into(),
        api_key: "test-account".into(),
        model: model.into(),
        api_protocol: ApiProtocol::Auto,
        reasoning_effort: None,
    }
}

#[test]
fn identical_settings_share_provider_and_every_effective_setting_isolated() {
    let cache = ProviderCache::default();
    let original = config("model-a");
    let provider = cache.get(original.clone());
    assert!(Arc::ptr_eq(&provider, &cache.get(original.clone())));
    let variants = [
        ProviderConfig {
            base_url: "https://different.test/v1".into(),
            ..original.clone()
        },
        ProviderConfig {
            api_key: "different-account".into(),
            ..original.clone()
        },
        config("model-b"),
        ProviderConfig {
            api_protocol: ApiProtocol::Responses,
            ..original.clone()
        },
        ProviderConfig {
            reasoning_effort: Some(ReasoningEffort::High),
            ..original.clone()
        },
    ];
    for variant in variants {
        assert!(!Arc::ptr_eq(&provider, &cache.get(variant)));
    }
    assert!(Arc::ptr_eq(&provider, &cache.get(original)));
}

#[test]
fn concurrent_turns_construct_one_provider() {
    let cache = Arc::new(ProviderCache::default());
    let start = Arc::new(std::sync::Barrier::new(8));
    let tasks = (0..8)
        .map(|_| {
            let cache = cache.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                cache.get(config("same-model"))
            })
        })
        .collect::<Vec<_>>();
    let providers = tasks
        .into_iter()
        .map(|task| task.join().unwrap())
        .collect::<Vec<_>>();
    assert!(providers
        .iter()
        .all(|provider| Arc::ptr_eq(provider, &providers[0])));
}

#[test]
fn cache_expires_without_extending_lifetime_on_reads() {
    let cache = ProviderCache::new(2, Duration::from_secs(300));
    let now = Instant::now();
    let original = cache.get_at(config("same-model"), now);
    assert!(Arc::ptr_eq(
        &original,
        &cache.get_at(config("same-model"), now + Duration::from_secs(299))
    ));
    let replacement = cache.get_at(config("same-model"), now + Duration::from_secs(300));
    assert!(!Arc::ptr_eq(&original, &replacement));
    // Eviction drops only the cache's reference, so an active turn keeps its
    // original provider and negotiated protocol.
    assert_eq!(Arc::strong_count(&original), 1);
}

#[test]
fn capacity_evicts_least_recently_used_entry() {
    let cache = ProviderCache::new(2, MAX_PROVIDER_AGE);
    let first = cache.get(config("first"));
    let second = cache.get(config("second"));
    assert!(Arc::ptr_eq(&first, &cache.get(config("first"))));
    cache.get(config("third"));
    assert_eq!(cache.entries.lock().unwrap().len(), 2);
    assert!(!Arc::ptr_eq(&second, &cache.get(config("second"))));
}

async fn fallback_server(
    recovered: Arc<std::sync::atomic::AtomicBool>,
) -> (String, tokio::task::JoinHandle<()>) {
    use axum::{
        body::Body,
        http::StatusCode,
        response::Response,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::atomic::Ordering;

    let app = Router::new()
        .route(
            "/v1/models/{model}",
            get(|| async {
                Json(serde_json::json!({"data": {
                    "preferred_api_protocol": "responses",
                    "supported_api_protocols": ["responses", "chat_completions"],
                    "supported_reasoning_efforts": ["low", "high"]
                }}))
            }),
        )
        .route(
            "/v1/responses",
            post(move || {
                let recovered = recovered.clone();
                async move {
                    let (status, body) = if recovered.load(Ordering::SeqCst) {
                        (StatusCode::OK, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n")
                    } else {
                        // Only this observed OneAPI wrapper permits fallback;
                        // an ordinary 404 must remain a permanent error.
                        (StatusCode::NOT_FOUND, "{\"error\":{\"message\":\"openai_error\",\"type\":\"bad_response_status_code\",\"code\":\"bad_response_status_code\"}}")
                    };
                    Response::builder()
                        .status(status)
                        .header("content-type", "text/event-stream")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(|| async {
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
                    .unwrap()
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1"), server)
}

#[tokio::test]
async fn expired_provider_rechecks_preferred_route_after_a_cached_fallback() {
    use futures_util::TryStreamExt;
    use miniq_models::{ChatMessage, CompletionRequest};
    use std::sync::atomic::{AtomicBool, Ordering};

    let recovered = Arc::new(AtomicBool::new(false));
    let (base_url, server) = fallback_server(recovered.clone()).await;
    let cache = ProviderCache::default();
    let config = ProviderConfig {
        base_url,
        ..config("test-model")
    };
    let request = || CompletionRequest {
        messages: vec![ChatMessage::user("hello")],
        tools: Vec::new(),
        trace: Default::default(),
        context_compact_threshold: None,
        temperature: None,
        max_output_tokens: Some(128),
    };
    let now = Instant::now();
    let original = cache.get_at(config.clone(), now);
    original
        .stream_complete(request())
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert_eq!(
        original
            .execution_info(None)
            .await
            .unwrap()
            .unwrap()
            .api_protocol,
        ApiProtocol::ChatCompletions
    );
    assert!(Arc::ptr_eq(&original, &cache.get(config.clone())));
    recovered.store(true, Ordering::SeqCst);
    let refreshed = cache.get_at(config, now + MAX_PROVIDER_AGE);
    assert!(!Arc::ptr_eq(&original, &refreshed));
    refreshed
        .stream_complete(request())
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
    assert_eq!(
        refreshed
            .execution_info(None)
            .await
            .unwrap()
            .unwrap()
            .api_protocol,
        ApiProtocol::Responses
    );
    assert_eq!(
        original
            .execution_info(None)
            .await
            .unwrap()
            .unwrap()
            .api_protocol,
        ApiProtocol::ChatCompletions
    );
    server.abort();
}
