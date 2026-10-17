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
