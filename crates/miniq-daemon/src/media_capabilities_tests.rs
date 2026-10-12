use super::*;
use std::sync::Arc;

use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use miniq_protocol::RpcRequest;

fn state() -> AppState {
    AppState::new(
        Store::open_in_memory().unwrap(),
        "token".into(),
        Arc::new(MockProvider::new(Vec::new())),
    )
}

fn provider(base_url: &str, api_key: &str) -> ProviderConfig {
    ProviderConfig {
        base_url: base_url.into(),
        api_key: api_key.into(),
        model: "chat-model".into(),
        api_protocol: Default::default(),
        reasoning_effort: None,
    }
}

#[tokio::test(start_paused = true)]
async fn worker_checks_at_startup_every_minute_and_on_provider_or_key_changes() {
    let state = state();
    state.settings.lock().unwrap().provider = Some(provider("https://first.test/v1", "first"));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let worker = tokio::spawn(run(state.clone(), CHECK_INTERVAL, move |media| {
        tx.send(media).unwrap();
        async { Ok(()) }
    }));
    let startup = rx.recv().await.unwrap();
    assert_eq!(startup.base_url, "https://first.test/v1");
    assert!(Arc::ptr_eq(
        startup.capabilities.as_ref().unwrap(),
        &state.media_capabilities
    ));
    tokio::time::advance(Duration::from_secs(59)).await;
    tokio::task::yield_now().await;
    assert!(rx.try_recv().is_err());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(rx.recv().await.unwrap().api_key, "first");
    let mut settings = state.settings.lock().unwrap().clone();
    settings.provider = Some(provider("https://first.test/v1", "new-key"));
    state.update_settings(settings.clone()).unwrap();
    assert_eq!(rx.recv().await.unwrap().api_key, "new-key");
    settings.provider = Some(provider("https://second.test/v1", "second"));
    state.update_settings(settings).unwrap();
    assert_eq!(rx.recv().await.unwrap().base_url, "https://second.test/v1");
    state.shutdown.cancel();
    worker.await.unwrap();
}

#[tokio::test]
async fn shutdown_cancels_in_flight_discovery_and_unconfigured_start_is_idle() {
    let state = state();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let worker = tokio::spawn(run(state.clone(), CHECK_INTERVAL, move |_| {
        tx.send(()).unwrap();
        std::future::pending::<Result<(), String>>()
    }));
    tokio::task::yield_now().await;
    assert!(rx.try_recv().is_err());
    let mut settings = state.settings.lock().unwrap().clone();
    settings.provider = Some(provider("https://service.test/v1", "secret"));
    state.update_settings(settings).unwrap();
    rx.recv().await.unwrap();
    state.shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn rpc_is_read_only_rejects_endpoints_and_reports_unconfigured() {
    let state = state();
    let mut request = RpcRequest::new("read", "media.capabilities", None);
    request.origin = Some("remote:phone".into());
    let response = crate::gateway::dispatch(&state, request).await;
    assert!(response.error.is_none());
    let result = response.result.unwrap();
    assert_eq!(result["configured"], false);
    assert_eq!(result["freshness"], "unconfigured");
    assert!(result["snapshot"].is_null());
    assert_eq!(
        crate::remote_policy::level("media.capabilities"),
        Some(crate::remote_policy::RemoteLevel::ReadOnly)
    );
    assert!(capabilities(&state, Some(json!({"baseUrl": "https://arbitrary.test"}))).is_err());
    assert!(capabilities(&state, Some(json!({"refresh": true}))).is_err());
    assert!(capabilities(&state, Some(json!({"sessionId": "missing"}))).is_err());
}

#[tokio::test]
async fn refresh_error_is_visible_without_disclosing_api_key() {
    let state = state();
    state.settings.lock().unwrap().provider =
        Some(provider("https://service.test/v1/", "secret-key"));
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut tx = Some(tx);
    let worker = tokio::spawn(run(state.clone(), CHECK_INTERVAL, move |_| {
        if let Some(tx) = tx.take() {
            let _ = tx.send(());
        }
        async { Err("request failed: secret-key".into()) }
    }));
    rx.await.unwrap();
    tokio::task::yield_now().await;
    let result = capabilities(&state, None).unwrap();
    assert_eq!(result["configured"], true);
    assert_eq!(result["freshness"], "missing");
    assert_eq!(result["lastError"], "request failed: [redacted]");
    assert!(!result.to_string().contains("secret-key"));
    assert!(!result.to_string().contains("apiKey"));
    state
        .settings
        .lock()
        .unwrap()
        .provider
        .as_mut()
        .unwrap()
        .base_url = "https://SERVICE.test:443/v1".into();
    assert_eq!(
        capabilities(&state, None).unwrap()["lastError"],
        result["lastError"]
    );
    state.shutdown.cancel();
    worker.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn empty_credentials_skip_startup_ticks_and_settings_refresh() {
    let state = state();
    state.settings.lock().unwrap().provider = Some(provider("https://service.test/v1", ""));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let worker = tokio::spawn(run(state.clone(), CHECK_INTERVAL, move |_| {
        tx.send(()).unwrap();
        async { Ok(()) }
    }));
    tokio::task::yield_now().await;
    tokio::time::advance(CHECK_INTERVAL).await;
    tokio::task::yield_now().await;
    assert!(rx.try_recv().is_err());
    let mut settings = state.settings.lock().unwrap().clone();
    settings.provider.as_mut().unwrap().api_key = " \t ".into();
    state.update_settings(settings.clone()).unwrap();
    tokio::task::yield_now().await;
    assert!(rx.try_recv().is_err());
    assert_eq!(
        capabilities(&state, None).unwrap()["freshness"],
        "unconfigured"
    );
    settings.provider.as_mut().unwrap().api_key = "configured-key".into();
    state.update_settings(settings).unwrap();
    rx.recv().await.unwrap();
    state.shutdown.cancel();
    worker.await.unwrap();
}

#[test]
fn parent_and_child_share_resolved_provider_defaults_and_registry() {
    let directory = tempfile::tempdir().unwrap();
    let state = state();
    state.settings.lock().unwrap().provider =
        Some(provider("https://service.test/v1", "session-key"));
    let workspace = state
        .store
        .create_workspace(directory.path().to_str().unwrap(), "workspace")
        .unwrap();
    let session = state
        .store
        .create_session(&workspace.id, "session")
        .unwrap();
    let resolved = state
        .provider_config_for_session(&session.id, Some("child-chat-model"))
        .unwrap()
        .unwrap();
    let parent = state.media_config_for(&resolved);
    let bridge = crate::agent_tasks::DaemonAgentBridge {
        state: state.clone(),
        session_id: session.id,
        workspace: directory.path().into(),
        workspace_roots: vec![directory.path().into()],
        workspace_id: workspace.id,
        depth: 0,
        agent_id: None,
        cancel: Default::default(),
    };
    // The resolved model-call config survives a concurrent settings change.
    state.settings.lock().unwrap().provider = Some(provider("https://other.test/v1", "other-key"));
    let child = bridge
        .child_context(
            directory.path().into(),
            "agent",
            Default::default(),
            false,
            Some(parent.clone()),
        )
        .media
        .unwrap();
    assert_eq!(child.base_url, resolved.base_url);
    assert_eq!(child.api_key, resolved.api_key);
    assert_eq!(child.image_model, "gpt-image-2.5-flare");
    assert_eq!(child.video_model, "grok-imagine-video-1.5");
    assert_eq!(child.music_model, "suno-v6");
    assert!(Arc::ptr_eq(
        child.capabilities.as_ref().unwrap(),
        parent.capabilities.as_ref().unwrap()
    ));
}

#[tokio::test]
async fn production_cache_survives_restart_and_startup_respects_fresh_ttl() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let app = axum::Router::new().fallback(axum::routing::get(
        move |request: axum::extract::Request| {
            let observed = observed.clone();
            async move {
                if request.uri().path().ends_with("/openapi.json") {
                    return (
                        axum::http::StatusCode::OK,
                        axum::Json(json!({"openapi": "3.0.0", "paths": {}})),
                    );
                }
                if !request.uri().path().ends_with("/models/details") {
                    return (
                        axum::http::StatusCode::NOT_FOUND,
                        axum::Json(json!({"error": "missing"})),
                    );
                }
                observed.fetch_add(1, Ordering::SeqCst);
                (
                    axum::http::StatusCode::OK,
                    axum::Json(json!({"data": {"models": [
                    {"model_id": "gpt-image-2.5-flare", "model_type": "image"},
                    {"model_id": "grok-imagine-video-1.5", "model_type": "video"},
                    {"model_id": "suno-v6", "model_type": "music"}
                ], "total": 3, "page": 1, "page_size": 100}})),
                )
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let service = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    let mut settings = crate::state::DaemonSettings::default();
    settings.provider = Some(provider(&base_url, "private-key"));
    let first = AppState::with_settings(
        Store::open_in_memory().unwrap(),
        "token".into(),
        settings.clone(),
        path.clone(),
    );
    let media = first.media_config_for(settings.provider.as_ref().unwrap());
    first.media_capabilities.refresh_due(&media).await.unwrap();
    let initial_requests = requests.load(Ordering::SeqCst);
    assert!(initial_requests > 0);
    let cached = capabilities(&first, None).unwrap();
    assert_eq!(cached["freshness"], "fresh");
    assert!(!cached.to_string().contains("private-key"));
    assert!(directory.path().join("cache/media-capabilities").exists());
    assert_channel_scoped_specs(&first, directory.path(), &media);
    let restarted = AppState::with_settings(
        Store::open_in_memory().unwrap(),
        "token".into(),
        settings,
        path,
    );
    assert_eq!(
        capabilities(&restarted, None).unwrap()["snapshot"],
        cached["snapshot"]
    );
    assert_registry_worker_refresh(&restarted).await;
    assert_eq!(
        requests.load(Ordering::SeqCst),
        initial_requests,
        "fresh startup cache avoids discovery HTTP"
    );
    restarted.shutdown.cancel();
    assert_expired_cache_refreshes(directory.path(), &restarted).await;
    assert!(requests.load(Ordering::SeqCst) > initial_requests);
    service.abort();
}

fn assert_channel_scoped_specs(first: &AppState, directory: &std::path::Path, media: &MediaConfig) {
    // Each executor decorates its own channel's specs without changing the router.
    let original = serde_json::to_value(first.router.specs()).unwrap();
    let executor = crate::executor::SessionToolExecutor {
        state: first.clone(),
        session_id: "spec-only".into(),
        router: first.router.clone(),
        ctx: miniq_tools::ToolContext::new(directory.into()).with_media(Some(media.clone())),
        cancel: Default::default(),
        permission_policy: crate::executor::PermissionPolicy::Inherit,
        review_plan: Default::default(),
    };
    let mut expected = first.router.specs();
    expected.retain(|spec| spec.name != "mcp_call");
    miniq_tools::decorate_media_specs(media, &mut expected);
    assert_eq!(
        serde_json::to_value(miniq_agent::ToolExecutor::specs(&executor)).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(
        serde_json::to_value(first.router.specs()).unwrap(),
        original
    );
    let mut other = executor;
    other.ctx.media = Some(first.media_config_for(&provider("https://other.test/v1", "other")));
    let mut undecorated = first.router.specs();
    undecorated.retain(|spec| spec.name != "mcp_call");
    miniq_tools::decorate_media_specs(other.ctx.media.as_ref().unwrap(), &mut undecorated);
    assert_eq!(
        serde_json::to_value(miniq_agent::ToolExecutor::specs(&other)).unwrap(),
        serde_json::to_value(undecorated).unwrap()
    );
}

async fn assert_registry_worker_refresh(state: &AppState) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut tx = Some(tx);
    let registry = state.media_capabilities.clone();
    let worker = tokio::spawn(run(state.clone(), CHECK_INTERVAL, move |media| {
        let registry = registry.clone();
        let tx = tx.take();
        async move {
            let result = registry.refresh_due(&media).await.map(|_| ());
            if let Some(tx) = tx {
                let _ = tx.send(result.clone());
            }
            result
        }
    }));
    rx.await.unwrap().unwrap();
    state.shutdown.cancel();
    worker.await.unwrap();
}

async fn assert_expired_cache_refreshes(directory: &std::path::Path, restarted: &AppState) {
    // An expired on-disk snapshot is served immediately, then actively refreshed.
    let cache_file = std::fs::read_dir(directory.join("cache/media-capabilities"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .unwrap();
    let mut stale: Value = serde_json::from_slice(&std::fs::read(&cache_file).unwrap()).unwrap();
    stale["fetchedAt"] = json!(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .saturating_sub(miniq_tools::MEDIA_REFRESH_INTERVAL_SECS));
    std::fs::write(&cache_file, serde_json::to_vec(&stale).unwrap()).unwrap();
    let expired = AppState::with_settings(
        Store::open_in_memory().unwrap(),
        "token".into(),
        restarted.settings.lock().unwrap().clone(),
        directory.join("settings.json"),
    );
    assert_eq!(capabilities(&expired, None).unwrap()["freshness"], "stale");
    assert_registry_worker_refresh(&expired).await;
    assert_eq!(capabilities(&expired, None).unwrap()["freshness"], "fresh");
}
