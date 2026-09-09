use super::*;
use miniq_models::{mock::MockProvider, ProviderConfig};
use miniq_protocol::SessionModelSettings;
use std::sync::Arc;

fn state() -> (AppState, String, String) {
    let store = miniq_memory::Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/tmp", "test").unwrap();
    let a = store.create_session(&workspace.id, "a").unwrap().id;
    let b = store.create_session(&workspace.id, "b").unwrap().id;
    let state = AppState::new(
        store,
        "test-only-token".into(),
        Arc::new(MockProvider::text("test")),
    );
    state.settings.lock().unwrap().provider = Some(ProviderConfig {
        base_url: "http://127.0.0.1:1/v1".into(),
        api_key: "private-key".into(),
        model: "gpt-5.6-sol".into(),
        api_protocol: ApiProtocol::Responses,
        reasoning_effort: None,
    });
    (state, a, b)
}

#[test]
fn model_catalog_url_adds_v1_only_for_a_bare_domain() {
    assert_eq!(
        model_catalog_url("https://models.test").unwrap().as_str(),
        "https://models.test/v1/models"
    );
    assert_eq!(
        model_catalog_url("https://models.test/v1/")
            .unwrap()
            .as_str(),
        "https://models.test/v1/models"
    );
    assert_eq!(
        model_catalog_url("https://models.test/custom/v1")
            .unwrap()
            .as_str(),
        "https://models.test/custom/v1/models"
    );
    assert_eq!(
        model_catalog_url("https://models.test?source=settings")
            .unwrap()
            .as_str(),
        "https://models.test/v1/models"
    );
}

#[tokio::test]
async fn session_update_is_independent_and_never_exposes_credentials() {
    let (state, a, b) = state();
    let baseline = state.settings.lock().unwrap().provider.clone();
    let response = update(&state, Some(json!({"sessionId":a,"settings":{"model":" custom/model ","apiProtocol":"chat_completions"}}))).await.unwrap();
    assert_eq!(response["effective"]["model"], "custom/model");
    assert!(!response.to_string().contains("private-key"));
    assert!(!response.to_string().contains("baseUrl"));
    assert_eq!(
        state.store.session_model_settings(&b).unwrap(),
        SessionModelSettings::default()
    );
    assert_eq!(state.settings.lock().unwrap().provider, baseline);
    let restored = update(&state, Some(json!({"sessionId":a,"settings":{}})))
        .await
        .unwrap();
    assert_eq!(restored["effective"]["model"], "gpt-5.6-sol");
    assert!(get(&state, Some(json!({"sessionId":"missing"}))).is_err());
}

#[tokio::test]
async fn invalid_choices_and_active_turn_changes_are_rejected() {
    let (state, a, _) = state();
    for settings in [
        json!({"model":" "}),
        json!({"model":"bad\nmodel"}),
        json!({"apiProtocol":"unknown"}),
        json!({"reasoningEffort":"extreme"}),
        json!({"unexpected":true}),
    ] {
        assert_eq!(
            update(&state, Some(json!({"sessionId":a,"settings":settings})))
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams as i64
        );
    }
    state.begin_turn(&a).unwrap();
    let error = update(
        &state,
        Some(json!({"sessionId":a,"settings":{"model":"another"}})),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SessionBusy as i64);
    assert_eq!(
        state.store.session_model_settings(&a).unwrap(),
        SessionModelSettings::default()
    );
}

#[tokio::test]
async fn authenticated_metadata_controls_custom_model_effort_choices() {
    use axum::{routing::get as route, Json, Router};
    let (state, a, _) = state();
    let app = Router::new()
        .route("/v1/models", route(|headers: axum::http::HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer private-key");
            Json(json!({"data":[{"id":"zeta"},{"id":"custom/model"},{"id":"Zeta"},{"id":"zeta"}]}))
        }))
        .route("/v1/models/{*model}", route(|| async {
            Json(json!({"data":{"preferred_api_protocol":"responses","supported_reasoning_efforts":["low","high"],"max_output":128000}}))
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    state
        .settings
        .lock()
        .unwrap()
        .provider
        .as_mut()
        .unwrap()
        .base_url = format!("http://{address}/v1");
    let catalog = catalog(&state).await.unwrap();
    assert_eq!(catalog["models"], json!(["custom/model", "Zeta", "zeta"]));
    assert!(!catalog.to_string().contains("private-key"));
    let described = describe(&state, Some(json!({"model":"custom/model"})))
        .await
        .unwrap();
    assert_eq!(described["apiProtocol"], "responses");
    assert_eq!(described["reasoningEfforts"], json!(["low", "high"]));
    assert_eq!(described["maxOutputTokens"], 128000);
    let changed = update(
        &state,
        Some(json!({"sessionId":a,"settings":{"model":"custom/model","reasoningEffort":"high"}})),
    )
    .await
    .unwrap();
    assert_eq!(changed["settings"]["reasoningEffort"], "high");
    assert!(update(
        &state,
        Some(json!({"sessionId":a,"settings":{"model":"custom/model","reasoningEffort":"max"}}))
    )
    .await
    .is_err());
    server.abort();
}

#[tokio::test]
async fn a_declared_partial_catalog_is_not_presented_as_complete() {
    use axum::{routing::get as route, Json, Router};
    let (state, _, _) = state();
    let app = Router::new().route(
        "/v1/models",
        route(|| async { Json(json!({"data":[{"id":"first"}],"has_more":true})) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    state
        .settings
        .lock()
        .unwrap()
        .provider
        .as_mut()
        .unwrap()
        .base_url = format!("http://{address}/v1");
    let error = catalog(&state).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ProviderError as i64);
    assert!(error.message.contains("partial model catalog"));
    server.abort();
}
