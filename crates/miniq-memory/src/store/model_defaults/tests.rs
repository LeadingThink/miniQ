use super::*;
use miniq_protocol::{ReasoningEffort, Session, Workspace};
use rusqlite::types::Value;

fn settings(
    model: &str,
    protocol: ApiProtocol,
    effort: Option<ReasoningEffort>,
) -> SessionModelSettings {
    SessionModelSettings {
        model: Some(model.into()),
        api_protocol: protocol,
        reasoning_effort: effort,
    }
}

fn old_defaults() -> SessionModelSettings {
    settings(
        "old-model",
        ApiProtocol::Responses,
        Some(ReasoningEffort::High),
    )
}

fn new_defaults() -> SessionModelSettings {
    settings("new-model", ApiProtocol::AnthropicMessages, None)
}

fn snapshot(store: &Store) -> Vec<(String, Value)> {
    store
        .conn
        .lock()
        .unwrap()
        .prepare(
            "SELECT 'session:' || session_id, settings_json FROM session_model_settings
             UNION ALL
             SELECT 'workspace:' || workspace_id, settings_json FROM workspace_model_settings
             ORDER BY 1",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}

#[test]
fn defaults_and_selected_session_persist_without_moving_existing_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("model-defaults.db");
    let store = Store::open(&db).unwrap();
    let workspace = store.create_workspace("/first", "first").unwrap();
    let empty_workspace = store.create_workspace("/empty", "empty").unwrap();
    let legacy = store.create_session(&workspace.id, "legacy").unwrap();
    let explicit = store.create_session(&workspace.id, "explicit").unwrap();
    let selected = store.create_session(&workspace.id, "selected").unwrap();
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM session_model_settings WHERE session_id = ?1",
            params![legacy.id],
        )
        .unwrap();
    // Preserve explicit model sessions byte-for-byte, including Auto and null effort.
    let explicit_settings = settings("explicit-model", ApiProtocol::Auto, None);
    let explicit_raw = "{ \"model\": \"explicit-model\" }";
    store
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE session_model_settings SET settings_json = ?2 WHERE session_id = ?1",
            params![explicit.id, explicit_raw],
        )
        .unwrap();
    store
        .set_session_model_settings(&selected.id, &explicit_settings)
        .unwrap();
    // Current workspace selection must never be used to resolve old sessions.
    store
        .set_workspace_model_settings(&workspace.id, &explicit_settings)
        .unwrap();

    store
        .update_model_defaults(&new_defaults(), &old_defaults(), Some(&selected.id))
        .unwrap();
    drop(store);
    let store = Store::open(&db).unwrap();

    assert_eq!(
        store.session_model_settings(&legacy.id).unwrap(),
        old_defaults()
    );
    assert_eq!(
        store.session_model_settings(&explicit.id).unwrap(),
        explicit_settings
    );
    assert_eq!(
        store.session_model_settings(&selected.id).unwrap(),
        new_defaults()
    );
    assert!(snapshot(&store).contains(&(
        format!("session:{}", explicit.id),
        Value::Text(explicit_raw.into()),
    )));
    for id in [&workspace.id, &empty_workspace.id] {
        assert_eq!(store.workspace_model_settings(id).unwrap(), new_defaults());
        let created = store.create_session(id, "new").unwrap();
        assert_eq!(
            store.session_model_settings(&created.id).unwrap(),
            new_defaults()
        );
    }
}

#[test]
fn repeated_global_updates_leave_all_existing_sessions_on_their_old_model() {
    let (store, workspace, legacy, explicit) = failure_fixture();
    store
        .update_model_defaults(&new_defaults(), &old_defaults(), None)
        .unwrap();
    store
        .update_model_defaults(&SessionModelSettings::default(), &new_defaults(), None)
        .unwrap();
    assert_eq!(
        store.session_model_settings(&legacy.id).unwrap(),
        old_defaults()
    );
    assert_eq!(
        store.session_model_settings(&explicit.id).unwrap(),
        old_defaults()
    );
    assert_eq!(
        store.workspace_model_settings(&workspace.id).unwrap(),
        SessionModelSettings::default()
    );
}

#[test]
fn legacy_selections_freeze_with_daemon_protocol_and_effort_semantics() {
    let selections = [
        SessionModelSettings::default(),
        SessionModelSettings {
            api_protocol: ApiProtocol::ChatCompletions,
            ..SessionModelSettings::default()
        },
        SessionModelSettings {
            reasoning_effort: Some(ReasoningEffort::Low),
            ..SessionModelSettings::default()
        },
        SessionModelSettings {
            api_protocol: ApiProtocol::AnthropicMessages,
            reasoning_effort: Some(ReasoningEffort::None),
            ..SessionModelSettings::default()
        },
    ];
    for previous in [old_defaults(), SessionModelSettings::default()] {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/legacy", "legacy").unwrap();
        let mut sessions = Vec::new();
        for selection in &selections {
            let session = store.create_session(&workspace.id, "legacy").unwrap();
            store
                .set_session_model_settings(&session.id, selection)
                .unwrap();
            sessions.push(session);
        }
        store
            .update_model_defaults(&new_defaults(), &previous, None)
            .unwrap();
        let expected_efforts = [
            previous.reasoning_effort,
            None,
            Some(ReasoningEffort::Low),
            Some(ReasoningEffort::None),
        ];
        let expected_protocols = [
            previous.api_protocol,
            ApiProtocol::ChatCompletions,
            previous.api_protocol,
            ApiProtocol::AnthropicMessages,
        ];
        for (index, session) in sessions.iter().enumerate() {
            assert_eq!(
                store.session_model_settings(&session.id).unwrap(),
                SessionModelSettings {
                    model: previous.model.clone(),
                    api_protocol: expected_protocols[index],
                    reasoning_effort: expected_efforts[index],
                },
            );
        }
    }
}

fn failure_fixture() -> (Store, Workspace, Session, Session) {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/failure", "failure").unwrap();
    let legacy = store.create_session(&workspace.id, "legacy").unwrap();
    let selected = store.create_session(&workspace.id, "selected").unwrap();
    store
        .set_session_model_settings(&selected.id, &old_defaults())
        .unwrap();
    store
        .set_workspace_model_settings(&workspace.id, &old_defaults())
        .unwrap();
    (store, workspace, legacy, selected)
}

#[test]
fn invalid_selected_session_is_rejected_before_any_write() {
    let (store, _, _, _) = failure_fixture();
    store
        .conn
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_settings_writes BEFORE INSERT ON session_model_settings
         BEGIN SELECT RAISE(FAIL, 'unexpected write'); END;",
        )
        .unwrap();
    let before = snapshot(&store);
    for session_id in ["missing-session", ""] {
        let result =
            store.update_model_defaults(&new_defaults(), &old_defaults(), Some(session_id));
        assert!(matches!(result, Err(MemoryError::NotFound(_))));
        assert_eq!(snapshot(&store), before);
    }
}

#[test]
fn failures_in_each_write_phase_roll_back_all_settings() {
    for phase in [
        "legacy_insert",
        "legacy_update",
        "selected",
        "workspace_insert",
        "workspace_update",
    ] {
        let (store, workspace, legacy, selected) = failure_fixture();
        let (operation, table, key, id) = match phase {
            "legacy_insert" => {
                store
                    .conn
                    .lock()
                    .unwrap()
                    .execute(
                        "DELETE FROM session_model_settings WHERE session_id = ?1",
                        params![legacy.id],
                    )
                    .unwrap();
                ("INSERT", "session_model_settings", "session_id", &legacy.id)
            }
            "legacy_update" => ("UPDATE", "session_model_settings", "session_id", &legacy.id),
            "selected" => (
                "UPDATE",
                "session_model_settings",
                "session_id",
                &selected.id,
            ),
            "workspace_insert" => {
                store
                    .conn
                    .lock()
                    .unwrap()
                    .execute(
                        "DELETE FROM workspace_model_settings WHERE workspace_id = ?1",
                        params![workspace.id],
                    )
                    .unwrap();
                (
                    "INSERT",
                    "workspace_model_settings",
                    "workspace_id",
                    &workspace.id,
                )
            }
            "workspace_update" => (
                "UPDATE",
                "workspace_model_settings",
                "workspace_id",
                &workspace.id,
            ),
            _ => unreachable!(),
        };
        store
            .conn
            .lock()
            .unwrap()
            .execute_batch(&format!(
                "CREATE TRIGGER fail_update BEFORE {operation} ON {table}
             WHEN NEW.{key} = '{id}' BEGIN SELECT RAISE(FAIL, 'injected failure'); END;",
            ))
            .unwrap();
        let before = snapshot(&store);
        let result =
            store.update_model_defaults(&new_defaults(), &old_defaults(), Some(&selected.id));
        assert!(
            matches!(result, Err(MemoryError::Sqlite(_))),
            "{phase}: {result:?}"
        );
        assert_eq!(snapshot(&store), before, "{phase}");
    }
}

#[test]
fn malformed_sqlite_or_json_settings_leave_every_row_unchanged() {
    for invalid in [
        Value::Text("{invalid json".into()),
        Value::Text("{\"apiProtocol\":\"invalid_protocol\"}".into()),
        Value::Blob(vec![0xff]),
    ] {
        let (store, _, _, selected) = failure_fixture();
        let workspace = store.create_workspace("/corrupt", "corrupt").unwrap();
        let corrupt = store.create_session(&workspace.id, "corrupt").unwrap();
        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE session_model_settings SET settings_json = ?2 WHERE session_id = ?1",
                params![corrupt.id, invalid],
            )
            .unwrap();
        let before = snapshot(&store);
        let error = store
            .update_model_defaults(&new_defaults(), &old_defaults(), Some(&selected.id))
            .unwrap_err();
        match invalid {
            Value::Blob(_) => assert!(matches!(error, MemoryError::Sqlite(_))),
            _ => assert!(matches!(error, MemoryError::Json(_))),
        }
        assert_eq!(snapshot(&store), before);
    }
}
