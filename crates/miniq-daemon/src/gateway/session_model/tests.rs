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
async fn global_update_applies_everywhere_and_never_exposes_credentials() {
    let (state, a, b) = state();
    let workspace_id = state.store.get_session(&a).unwrap().workspace_id;
    let other_workspace = state.store.create_workspace("/other", "other").unwrap();
    let other = state
        .store
        .create_session(&other_workspace.id, "other")
        .unwrap();
    let response = global_update(
        &state,
        Some(json!({"settings":{"model":" custom/model ","apiProtocol":"chat_completions"}})),
    )
    .await
    .unwrap();
    assert_eq!(response["effective"]["model"], "custom/model");
    assert!(!response.to_string().contains("private-key"));
    assert!(!response.to_string().contains("baseUrl"));
    assert_eq!(
        state.store.session_model_settings(&b).unwrap(),
        state.store.session_model_settings(&a).unwrap()
    );
    assert_eq!(
        state.store.session_model_settings(&other.id).unwrap(),
        state.store.session_model_settings(&a).unwrap()
    );
    let next = state.store.create_session(&workspace_id, "next").unwrap();
    assert_eq!(
        state.store.session_model_settings(&next.id).unwrap(),
        state.store.session_model_settings(&a).unwrap()
    );
    let workspace = workspace_get(&state, Some(json!({"workspaceId": workspace_id}))).unwrap();
    assert_eq!(workspace["settings"]["model"], "custom/model");
    assert_eq!(workspace["effective"]["model"], "custom/model");
    assert!(!workspace.to_string().contains("private-key"));
    let provider = state.settings.lock().unwrap().provider.clone().unwrap();
    assert_eq!(provider.model, "custom/model");
    assert_eq!(provider.api_protocol, ApiProtocol::ChatCompletions);
    assert_eq!(provider.api_key, "private-key");
    assert_eq!(provider.base_url, "http://127.0.0.1:1/v1");
    assert!(get(&state, Some(json!({"sessionId":"missing"}))).is_err());
}

#[tokio::test]
async fn invalid_choices_are_rejected_and_active_turns_keep_running() {
    let (state, a, _) = state();
    for settings in [
        json!({"model":" "}),
        json!({"model":"bad\nmodel"}),
        json!({"apiProtocol":"unknown"}),
        json!({"reasoningEffort":"extreme"}),
        json!({"unexpected":true}),
    ] {
        assert_eq!(
            global_update(&state, Some(json!({"settings":settings})))
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams as i64
        );
    }
    state.begin_turn(&a).unwrap();
    let changed = global_update(&state, Some(json!({"settings":{"model":"another"}})))
        .await
        .unwrap();
    assert_eq!(changed["effective"]["model"], "another");
    assert_eq!(
        state.store.session_model_settings(&a).unwrap(),
        SessionModelSettings {
            model: Some("another".into()),
            ..Default::default()
        }
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
