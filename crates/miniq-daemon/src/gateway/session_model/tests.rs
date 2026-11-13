use super::*;
use miniq_models::{mock::MockProvider, ProviderConfig};
use miniq_protocol::SessionModelSettings;
use std::sync::Arc;

mod global_updates;

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
async fn global_update_failures_preserve_file_runtime_database_and_events() {
    for database_failure in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("test.db");
        let path = dir.path().join("settings.json");
        let (mut state, _, _) = state();
        state.store = Arc::new(miniq_memory::Store::open(&db).unwrap());
        state.settings_path = Some(Arc::new(path.clone()));
        let workspace = state.store.create_workspace("/test", "test").unwrap();
        let session = state.store.create_session(&workspace.id, "test").unwrap();
        let previous = state.settings.lock().unwrap().clone();
        previous.save(&path).unwrap();
        let original_file = std::fs::read(&path).unwrap();
        let mut events = state.events.subscribe();
        if database_failure {
            // Fail after legacy sessions and the selected session have been written.
            rusqlite::Connection::open(&db)
                .unwrap()
                .execute_batch(
                    "CREATE TRIGGER reject_model_sync BEFORE INSERT ON workspace_model_settings
                 BEGIN SELECT RAISE(ABORT, 'injected model sync failure'); END;",
                )
                .unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
            std::fs::create_dir(&path).unwrap();
        }
        let error = global_update(
            &state,
            Some(json!({"sessionId":session.id,"settings":{"model":"new-global"}})),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InternalError as i64);
        assert_eq!(
            serde_json::to_value(&*state.settings.lock().unwrap()).unwrap(),
            serde_json::to_value(&previous).unwrap(),
        );
        assert_eq!(
            state.store.workspace_model_settings(&workspace.id).unwrap(),
            SessionModelSettings::default()
        );
        assert_eq!(
            state.store.session_model_settings(&session.id).unwrap(),
            SessionModelSettings::default()
        );
        assert!(events.try_recv().is_err());
        if database_failure {
            assert_eq!(std::fs::read(&path).unwrap(), original_file);
            let reopened = miniq_memory::Store::open(&db).unwrap();
            assert_eq!(
                reopened.workspace_model_settings(&workspace.id).unwrap(),
                SessionModelSettings::default()
            );
        } else {
            assert!(path.is_dir());
        }
    }
}

#[tokio::test]
async fn new_projects_and_sessions_inherit_global_effort_but_explicit_models_can_clear_it() {
    let (state, _, _) = state();
    global_update(
        &state,
        Some(json!({"settings":{
            "model":"gpt-5.6-sol", "apiProtocol":"responses", "reasoningEffort":"high"
        }})),
    )
    .await
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let workspace = super::super::workspace::open(
        &state,
        Some(json!({
            "path":directory.path().to_str().unwrap(), "name":"new project"
        })),
    )
    .unwrap();
    let workspace_id = workspace["id"].as_str().unwrap();
    let response = workspace_get(&state, Some(json!({"workspaceId":workspace_id}))).unwrap();
    assert_eq!(response["effective"]["reasoningEffort"], "high");
    let session = super::super::session::create(&state, Some(json!({"workspaceId":workspace_id})))
        .await
        .unwrap();
    let id = session["id"].as_str().unwrap();
    let inherited = get(&state, Some(json!({"sessionId":id}))).unwrap();
    assert_eq!(inherited["settings"]["reasoningEffort"], "high");
    assert_eq!(inherited["effective"]["reasoningEffort"], "high");
    let cleared = update(
        &state,
        Some(json!({"sessionId":id,"settings":{
            "model":"gpt-5.6-sol", "apiProtocol":"responses", "reasoningEffort":null
        }})),
    )
    .await
    .unwrap();
    assert_eq!(cleared["effective"]["reasoningEffort"], Value::Null);
    assert_eq!(
        state
            .settings
            .lock()
            .unwrap()
            .provider
            .as_ref()
            .unwrap()
            .reasoning_effort,
        Some(miniq_protocol::ReasoningEffort::High)
    );
}

#[tokio::test]
async fn invalid_choices_are_rejected_and_global_updates_keep_active_turns_running() {
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
    let changed = global_update(
        &state,
        Some(json!({"sessionId":a,"settings":{"model":"another"}})),
    )
    .await
    .unwrap();
    assert_eq!(changed["effective"]["model"], "another");
    assert_eq!(
        state.store.session_model_settings(&a).unwrap(),
        SessionModelSettings {
            model: Some("another".into()),
            ..SessionModelSettings::default()
        }
    );
    assert!(state.active_turns.lock().unwrap().contains_key(&a));
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
async fn openai_catalog_without_model_type_preserves_model_ids() {
    use axum::{routing::get as route, Json, Router};
    let (state, _, _) = state();
    let app = Router::new().route(
        "/v1/models",
        route(|| async {
            Json(json!({"data": [
                {"id": "custom/model", "object": "model", "owned_by": "provider"},
                {"id": "alpha", "model_type": "chat"},
                {"id": "custom/model"},
                {"id": "image-model", "model_type": "image"},
                {"id": "embedding-model", "model_type": "embedding"}
            ]}))
        }),
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
    let result = catalog(&state).await.unwrap();
    assert_eq!(result["models"], json!(["alpha", "custom/model"]));
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

#[tokio::test]
async fn model_performance_preserves_all_samples_and_normalizes_field_names() {
    use axum::{routing::get as route, Json, Router};
    let app = Router::new().route(
        "/v1/models/perf",
        route(|| async move {
            Json(json!({
                "code": "0",
                "msg": "获取模型性能指标成功",
                "data": {
                    "window_hours": 72,
                    "models": {
                        "gpt-5.6-sol": {
                            "availability": 99.94,
                            "throughput": 97.7,
                            "samples": 9511,
                            "series": [
                                {"ts": 1793095200_u64, "availability": 100.0, "samples": 98},
                                {"ts": 1793098800_u64, "availability": null, "samples": 0}
                            ]
                        }
                    }
                }
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let result = performance_for(&format!("http://{address}/v1/models/perf"))
        .await
        .unwrap();
    assert_eq!(result["windowHours"], 72);
    assert_eq!(result["models"]["gpt-5.6-sol"]["availability"], 99.94);
    assert_eq!(result["models"]["gpt-5.6-sol"]["throughput"], 97.7);
    assert_eq!(
        result["models"]["gpt-5.6-sol"]["series"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        result["models"]["gpt-5.6-sol"]["series"][1]["availability"],
        Value::Null
    );
    server.abort();
}
