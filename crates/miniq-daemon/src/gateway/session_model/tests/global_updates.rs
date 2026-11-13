use super::*;
use miniq_protocol::ReasoningEffort;

fn selected(model: &str) -> SessionModelSettings {
    SessionModelSettings {
        model: Some(model.into()),
        api_protocol: ApiProtocol::Responses,
        reasoning_effort: Some(ReasoningEffort::High),
    }
}

async fn create(state: &AppState, workspace: &str) -> String {
    super::super::super::session::create(state, Some(json!({"workspaceId":workspace})))
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}

#[tokio::test]
async fn changing_b_preserves_a_and_other_workspaces_and_new_c_inherits_b() {
    let (state, a, b) = state();
    let workspace = state.store.get_session(&a).unwrap().workspace_id;
    let other = state.store.create_workspace("/other", "other").unwrap();
    let untouched = state.store.create_session(&other.id, "untouched").unwrap();
    let old = selected("gpt-5.6-sol");
    state.store.set_session_model_settings(&a, &old).unwrap();
    state
        .store
        .set_session_model_settings(&untouched.id, &old)
        .unwrap();
    let changed = selected("gpt-5.4");
    let mut events = state.events.subscribe();
    let response = global_update(&state, Some(json!({"sessionId":b,"settings":changed})))
        .await
        .unwrap();
    assert_eq!(
        response["settings"],
        serde_json::to_value(&changed).unwrap()
    );
    assert_eq!(response["effective"], response["settings"]);
    assert!(!response.to_string().contains("private-key"));
    assert!(!response.to_string().contains("baseUrl"));
    assert_eq!(state.store.session_model_settings(&a).unwrap(), old);
    assert_eq!(
        state.store.session_model_settings(&untouched.id).unwrap(),
        old
    );
    assert_eq!(state.store.session_model_settings(&b).unwrap(), changed);
    assert!(
        matches!(events.try_recv().unwrap(), Event::GlobalModelSettingsChanged { settings } if settings == changed)
    );
    assert!(
        matches!(events.try_recv().unwrap(), Event::ModelSettingsChanged { session_id, workspace_id, settings } if session_id == b && workspace_id == workspace && settings == changed)
    );
    assert!(events.try_recv().is_err());
    for workspace in [&workspace, &other.id] {
        assert_eq!(
            state.store.workspace_model_settings(workspace).unwrap(),
            changed
        );
        let c = create(&state, workspace).await;
        assert_eq!(state.store.session_model_settings(&c).unwrap(), changed);
    }
    let provider = state.settings.lock().unwrap().provider.clone().unwrap();
    assert_eq!(provider.model, "gpt-5.4");
    assert_eq!(provider.api_protocol, changed.api_protocol);
    assert_eq!(provider.reasoning_effort, changed.reasoning_effort);
    assert_eq!(provider.api_key, "private-key");
}

#[tokio::test]
async fn drafts_change_only_defaults_and_legacy_sessions_keep_the_old_effective_selection() {
    for explicit_null in [false, true] {
        let (state, a, b) = state();
        let workspace = state.store.get_session(&a).unwrap().workspace_id;
        state
            .settings
            .lock()
            .unwrap()
            .provider
            .as_mut()
            .unwrap()
            .reasoning_effort = Some(ReasoningEffort::High);
        state
            .store
            .set_session_model_settings(
                &b,
                &SessionModelSettings {
                    api_protocol: ApiProtocol::ChatCompletions,
                    ..Default::default()
                },
            )
            .unwrap();
        // Workspace choices are creation defaults, not an existing session's baseline.
        state
            .store
            .set_workspace_model_settings(&workspace, &selected("unrelated-workspace-default"))
            .unwrap();
        let before_a = get(&state, Some(json!({"sessionId":a}))).unwrap()["effective"].clone();
        let before_b = get(&state, Some(json!({"sessionId":b}))).unwrap()["effective"].clone();
        let mut events = state.events.subscribe();
        let mut params =
            json!({"settings":{"model":"draft-model","apiProtocol":"auto","reasoningEffort":null}});
        // Exercise both omitted and explicit null sessionId.
        if explicit_null {
            params["sessionId"] = Value::Null;
        }
        global_update(&state, Some(params)).await.unwrap();
        assert_eq!(
            get(&state, Some(json!({"sessionId":a}))).unwrap()["effective"],
            before_a
        );
        assert_eq!(
            get(&state, Some(json!({"sessionId":b}))).unwrap()["effective"],
            before_b
        );
        assert_eq!(
            state.store.session_model_settings(&a).unwrap(),
            selected("gpt-5.6-sol")
        );
        assert!(matches!(
            events.try_recv().unwrap(),
            Event::GlobalModelSettingsChanged { .. }
        ));
        assert!(events.try_recv().is_err());
        let c = create(&state, &workspace).await;
        assert_eq!(
            get(&state, Some(json!({"sessionId":c}))).unwrap()["effective"]["model"],
            "draft-model"
        );
        global_update(&state, Some(json!({"settings":{"model":"next-draft"}})))
            .await
            .unwrap();
        assert_eq!(
            get(&state, Some(json!({"sessionId":c}))).unwrap()["effective"]["model"],
            "draft-model"
        );
    }
}

#[tokio::test]
async fn session_and_workspace_updates_retain_their_local_scope() {
    let (state, a, b) = state();
    let workspace = state.store.get_session(&a).unwrap().workspace_id;
    update(
        &state,
        Some(json!({"sessionId":a,"settings":selected("gpt-5.6-sol")})),
    )
    .await
    .unwrap();
    let before = get(&state, Some(json!({"sessionId":a}))).unwrap();
    workspace_update(
        &state,
        Some(json!({
            "workspaceId":workspace,"settings":{"model":"workspace-choice"}
        })),
    )
    .await
    .unwrap();
    assert_eq!(get(&state, Some(json!({"sessionId":a}))).unwrap(), before);
    assert_eq!(
        state.store.session_model_settings(&b).unwrap(),
        SessionModelSettings::default()
    );
    let c = create(&state, &workspace).await;
    assert_eq!(
        get(&state, Some(json!({"sessionId":c}))).unwrap()["effective"]["model"],
        "workspace-choice"
    );
    update(&state, Some(json!({"sessionId":a,"settings":{}})))
        .await
        .unwrap();
    global_update(&state, Some(json!({"settings":{"model":"new-global"}})))
        .await
        .unwrap();
    assert_eq!(
        get(&state, Some(json!({"sessionId":a}))).unwrap()["effective"]["model"],
        "gpt-5.6-sol"
    );
    assert_eq!(
        get(&state, Some(json!({"sessionId":c}))).unwrap()["effective"]["model"],
        "workspace-choice"
    );
    assert_eq!(
        state
            .settings
            .lock()
            .unwrap()
            .provider
            .as_ref()
            .unwrap()
            .model,
        "new-global"
    );
}

#[tokio::test]
async fn missing_session_is_rejected_before_persisting_or_emitting_anything() {
    let (mut state, a, _) = state();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    state.settings_path = Some(Arc::new(path.clone()));
    let previous = state.settings.lock().unwrap().clone();
    previous.save(&path).unwrap();
    let file = std::fs::read(&path).unwrap();
    let workspace = state.store.get_session(&a).unwrap().workspace_id;
    let mut events = state.events.subscribe();
    let error = global_update(
        &state,
        Some(json!({"sessionId":"missing", "settings":selected("gpt-5.4")})),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SessionNotFound as i64);
    assert_eq!(std::fs::read(&path).unwrap(), file);
    assert_eq!(
        serde_json::to_value(&*state.settings.lock().unwrap()).unwrap(),
        serde_json::to_value(previous).unwrap()
    );
    assert_eq!(
        state.store.session_model_settings(&a).unwrap(),
        SessionModelSettings::default()
    );
    assert_eq!(
        state.store.workspace_model_settings(&workspace).unwrap(),
        SessionModelSettings::default()
    );
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn defaults_and_isolated_sessions_survive_database_and_settings_reload() {
    let (mut state, _, _) = state();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("state.db");
    let path = dir.path().join("settings.json");
    state.store = Arc::new(miniq_memory::Store::open(&db).unwrap());
    state.settings_path = Some(Arc::new(path.clone()));
    let workspace = state
        .store
        .create_workspace("/persisted", "persisted")
        .unwrap();
    let a = state.store.create_session(&workspace.id, "a").unwrap();
    let b = state.store.create_session(&workspace.id, "b").unwrap();
    let before = get(&state, Some(json!({"sessionId":a.id}))).unwrap()["effective"].clone();
    global_update(
        &state,
        Some(json!({"sessionId":b.id,"settings":selected("gpt-5.4")})),
    )
    .await
    .unwrap();
    drop(state);
    let (mut state, _, _) = super::state();
    state.store = Arc::new(miniq_memory::Store::open(&db).unwrap());
    *state.settings.lock().unwrap() = crate::state::DaemonSettings::load(&path);
    assert_eq!(
        get(&state, Some(json!({"sessionId":a.id}))).unwrap()["effective"],
        before
    );
    assert_eq!(
        state.store.session_model_settings(&b.id).unwrap(),
        selected("gpt-5.4")
    );
    let c = create(&state, &workspace.id).await;
    assert_eq!(
        state.store.session_model_settings(&c).unwrap(),
        selected("gpt-5.4")
    );
}

#[test]
fn legacy_provider_reads_wait_until_default_snapshot_is_complete() {
    use std::sync::mpsc;
    use std::time::Duration;
    let (state, a, _) = state();
    let state = Arc::new(state);
    let mut settings = state.settings.lock().unwrap();
    let previous = crate::session_models::snapshot_selection(
        settings.provider.clone(),
        SessionModelSettings::default(),
    );
    // Pause the update in the exact gap between publishing the provider and
    // freezing model-less sessions. Readers must wait for both writes.
    settings.provider.as_mut().unwrap().model = "new-global".into();
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let reader = state.clone();
    let handle = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        result_tx
            .send(
                reader
                    .provider_config_for_session(&a, None)
                    .unwrap()
                    .unwrap()
                    .model,
            )
            .unwrap();
    });
    started_rx.recv().unwrap();
    assert!(matches!(
        result_rx.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    state
        .store
        .update_model_defaults(&selected("new-global"), &previous, None)
        .unwrap();
    drop(settings);
    assert_eq!(
        result_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        "gpt-5.6-sol"
    );
    handle.join().unwrap();
}
