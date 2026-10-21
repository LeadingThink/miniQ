use super::*;

/// Return the query plan text for one statement.
fn plan(store: &Store, sql: &str) -> String {
    let conn = store.conn.lock().unwrap();
    let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let rows = statement
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap();
    rows.map(|row| row.unwrap()).collect::<Vec<_>>().join(" | ")
}

#[test]
fn startup_recovery_never_scans_whole_call_tables() {
    let store = Store::open_in_memory().unwrap();
    let statements = [
        (
            "UPDATE tool_calls SET status = 'cancelled', completed_at = 'now' \
             WHERE status IN ('pending', 'waiting_approval', 'running')",
            "idx_tool_calls_active",
        ),
        (
            "UPDATE model_calls SET status = 'interrupted' WHERE status = 'running'",
            "idx_model_calls_running",
        ),
    ];
    for (sql, index) in statements {
        let plan = plan(&store, sql);
        assert!(plan.contains(index), "{sql} must use {index}, got: {plan}");
    }
}

#[test]
fn startup_recovery_still_closes_in_flight_work() {
    let store = Store::open_in_memory().unwrap();
    {
        let conn = store.conn.lock().unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, path, name, created_at, updated_at)
               VALUES ('w', '/w', 'w', 'now', 'now');
             INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at)
               VALUES ('s', 'w', 't', 'running', 'now', 'now');
             INSERT INTO tool_calls (id, session_id, tool_name, input_json, status, created_at)
               VALUES ('t1', 's', 'shell', '{}', 'running', 'now'),
                      ('t2', 's', 'shell', '{}', 'completed', 'now');
             INSERT INTO model_calls (id, session_id, started_at, status, record_json)
               VALUES ('m1', 's', 'now', 'running', '{}'),
                      ('m2', 's', 'now', 'completed', '{}');",
        )
        .unwrap();
    }
    let recovered = store.recover_interrupted_work().unwrap();
    assert_eq!(recovered.sessions_failed, 1);
    assert_eq!(recovered.tool_calls_cancelled, 1);

    let conn = store.conn.lock().unwrap();
    let status = |table: &str, id: &str| -> String {
        conn.query_row(
            &format!("SELECT status FROM {table} WHERE id = ?1"),
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(status("tool_calls", "t1"), "cancelled");
    assert_eq!(status("tool_calls", "t2"), "completed");
    assert_eq!(status("model_calls", "m1"), "interrupted");
    assert_eq!(status("model_calls", "m2"), "completed");
}

#[test]
fn recovery_retains_explicit_failure_reasons_and_only_changes_active_turns() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/fixture", "fixture").unwrap();
    let one = store.create_session(&workspace.id, "one").unwrap();
    let two = store.create_session(&workspace.id, "two").unwrap();
    let done = store.create_session(&workspace.id, "done").unwrap();
    for session in [&one, &two, &done] {
        store
            .append_message(&session.id, miniq_protocol::Role::User, "task")
            .unwrap();
    }
    store
        .update_session_status(&one.id, miniq_protocol::SessionStatus::Running)
        .unwrap();
    store
        .update_session_status(&two.id, miniq_protocol::SessionStatus::WaitingApproval)
        .unwrap();
    store
        .record_turn_outcome(&done.id, "completed", None)
        .unwrap();
    store.recover_interrupted_session(&one.id).unwrap();
    let one_outcome = store.last_turn_outcome(&one.id).unwrap().unwrap();
    assert_eq!(one_outcome["status"], "failed");
    assert_eq!(
        one_outcome["error"],
        "turn was interrupted before completion; no active execution remains"
    );
    assert!(store.last_turn_outcome(&two.id).unwrap().is_none());

    store.recover_interrupted_work().unwrap();
    assert_eq!(
        store.last_turn_outcome(&one.id).unwrap().unwrap(),
        one_outcome
    );
    assert_eq!(
        store.last_turn_outcome(&two.id).unwrap().unwrap()["error"],
        "daemon restarted before the turn completed"
    );
    assert_eq!(
        store.last_turn_outcome(&done.id).unwrap().unwrap()["status"],
        "completed"
    );
}

#[test]
fn recovery_does_not_replace_a_terminal_outcome_written_before_a_crash() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/fixture", "fixture").unwrap();
    for recovery in ["session", "startup"] {
        let session = store.create_session(&workspace.id, recovery).unwrap();
        store
            .append_message(&session.id, miniq_protocol::Role::User, "task")
            .unwrap();
        store
            .update_session_status(&session.id, miniq_protocol::SessionStatus::Running)
            .unwrap();
        store
            .record_turn_outcome(&session.id, "failed", Some("original provider failure"))
            .unwrap();
        if recovery == "session" {
            store.recover_interrupted_session(&session.id).unwrap();
        } else {
            store.recover_interrupted_work().unwrap();
        }
        assert_eq!(
            store.last_turn_outcome(&session.id).unwrap().unwrap()["error"],
            "original provider failure"
        );
        assert_eq!(store.count_audit_events(&session.id).unwrap(), 1);
    }
}
