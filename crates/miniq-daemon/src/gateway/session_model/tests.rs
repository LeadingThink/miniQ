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
async fn global_update_changes_defaults_without_overwriting_session_or_project_choices() {
    let (state, a, b) = state();
    let workspace_id = state.store.get_session(&a).unwrap().workspace_id;
    let selected = SessionModelSettings {
        model: Some("claude-sonnet-4.6".into()),
        api_protocol: ApiProtocol::AnthropicMessages,
        reasoning_effort: None,
    };
    state
        .store
        .set_session_model_settings(&a, &selected)
        .unwrap();
    let other_workspace = state.store.create_workspace("/other", "other").unwrap();
    state
        .store
        .set_workspace_model_settings(&other_workspace.id, &selected)
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
    assert_eq!(state.store.session_model_settings(&a).unwrap(), selected);
    assert_eq!(
        state.store.session_model_settings(&b).unwrap(),
        SessionModelSettings::default()
    );
    assert_eq!(
        state
            .store
            .workspace_model_settings(&other_workspace.id)
            .unwrap(),
        selected
    );
    let workspace = workspace_get(&state, Some(json!({"workspaceId": workspace_id}))).unwrap();
    assert_eq!(workspace["settings"]["model"], Value::Null);
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
        SessionModelSettings::default()
    );
    assert!(state.active_turns.lock().unwrap().contains_key(&a));
}

#[tokio::test]
async fn creating_and_updating_sessions_isolates_models_protocols_and_effort() {
    let (state, a, b) = state();
    let workspace_id = state.store.get_session(&a).unwrap().workspace_id;
    let before_a = get(&state, Some(json!({"sessionId":a}))).unwrap();
    let before_b = get(&state, Some(json!({"sessionId":b}))).unwrap();
    let created = super::super::session::create(&state, Some(json!({
        "workspaceId":workspace_id,
        "modelSettings":{"model":"gpt-5.6-sol", "apiProtocol":"responses", "reasoningEffort":"high"}
    }))).await.unwrap();
    let id = created["id"].as_str().unwrap();
    let chosen = get(&state, Some(json!({"sessionId":id}))).unwrap();
    assert_eq!(chosen["effective"]["reasoningEffort"], "high");
    assert_eq!(
        state
            .provider_config_for_session(id, None)
            .unwrap()
            .unwrap()
            .reasoning_effort,
        Some(miniq_protocol::ReasoningEffort::High)
    );
    assert_eq!(get(&state, Some(json!({"sessionId":a}))).unwrap(), before_a);
    assert_eq!(get(&state, Some(json!({"sessionId":b}))).unwrap(), before_b);
    assert_eq!(
        state.store.workspace_model_settings(&workspace_id).unwrap(),
        SessionModelSettings::default()
    );

    workspace_update(
        &state,
        Some(json!({"workspaceId": workspace_id, "settings":{"model":"gemini-3.8-flash"}})),
    )
    .await
    .unwrap();
    assert_eq!(get(&state, Some(json!({"sessionId":id}))).unwrap(), chosen);
    let next = super::super::session::create(&state, Some(json!({"workspaceId":workspace_id})))
        .await
        .unwrap();
    let next_id = next["id"].as_str().unwrap();
    let next_settings = get(&state, Some(json!({"sessionId":next_id}))).unwrap();
    assert_eq!(next_settings["effective"]["model"], "gemini-3.8-flash");
    assert_eq!(next_settings["effective"]["reasoningEffort"], Value::Null);
    global_update(&state, Some(json!({"settings":{"model":"new-global"}})))
        .await
        .unwrap();
    assert_eq!(get(&state, Some(json!({"sessionId":id}))).unwrap(), chosen);
    assert_eq!(
        get(&state, Some(json!({"sessionId":next_id}))).unwrap(),
        next_settings
    );
    update(&state, Some(json!({"sessionId":id,"settings":{"model":"claude-sonnet-4.6","apiProtocol":"anthropic_messages"}}))).await.unwrap();
    let config = state
        .provider_config_for_session(id, None)
        .unwrap()
        .unwrap();
    assert_eq!(config.model, "claude-sonnet-4.6");
    assert_eq!(config.api_protocol, ApiProtocol::AnthropicMessages);
    assert_eq!(config.reasoning_effort, None);
    assert_eq!(
        get(&state, Some(json!({"sessionId":next_id}))).unwrap(),
        next_settings
    );
}

#[tokio::test]
async fn invalid_draft_settings_do_not_create_a_partial_session() {
    let (state, a, _) = state();
    let workspace_id = state.store.get_session(&a).unwrap().workspace_id;
    let before = state
        .store
        .list_sessions(Some(&workspace_id))
        .unwrap()
        .len();
    for settings in [
        json!({"model":" "}),
        json!({"model":"bad\nmodel"}),
        json!({"apiProtocol":"invalid"}),
    ] {
        let error = super::super::session::create(
            &state,
            Some(json!({"workspaceId":workspace_id, "modelSettings":settings})),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams as i64);
        assert_eq!(
            state
                .store
                .list_sessions(Some(&workspace_id))
                .unwrap()
                .len(),
            before
        );
    }
}

#[tokio::test]
async fn sessions_created_with_defaults_keep_their_model_when_global_defaults_change() {
    let (state, a, _) = state();
    let workspace_id = state.store.get_session(&a).unwrap().workspace_id;
    let created = super::super::session::create(&state, Some(json!({"workspaceId":workspace_id})))
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    let before = get(&state, Some(json!({"sessionId":id}))).unwrap();
    global_update(&state, Some(json!({"settings":{"model":"new-global"}})))
        .await
        .unwrap();
    assert_eq!(get(&state, Some(json!({"sessionId":id}))).unwrap(), before);
    let next = super::super::session::create(&state, Some(json!({"workspaceId":workspace_id})))
        .await
        .unwrap();
    assert_eq!(
        get(&state, Some(json!({"sessionId":next["id"]}))).unwrap()["effective"]["model"],
        "new-global"
    );
    let reset = update(&state, Some(json!({"sessionId":id,"settings":{}})))
        .await
        .unwrap();
    assert_eq!(reset["effective"]["model"], "new-global");
    global_update(&state, Some(json!({"settings":{"model":"another-global"}})))
        .await
        .unwrap();
    assert_eq!(get(&state, Some(json!({"sessionId":id}))).unwrap(), reset);
}

#[tokio::test]
async fn authenticated_metadata_controls_custom_model_effort_choices() {
    use axum::{routing::get as route, Json, Router};
    let (state, a, b) = state();
    let app = Router::new()
        .route("/v1/models", route(|headers: axum::http::HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer private-key");
            Json(json!({"data":[{"id":"zeta","model_type":"chat"},{"id":"custom/model","model_type":"chat"},{"id":"Zeta","model_type":"chat"},{"id":"zeta","model_type":"chat"},{"id":"gpt-image-2","model_type":"image"}]}))
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
    assert_eq!(
        state
            .store
            .session_model_settings(&a)
            .unwrap()
            .model
            .as_deref(),
        Some("custom/model")
    );
    assert_eq!(
        state.store.session_model_settings(&b).unwrap(),
        SessionModelSettings::default()
    );
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
