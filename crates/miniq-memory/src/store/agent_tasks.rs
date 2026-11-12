use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{MemoryError, Result, Store};

/// Lifecycle metadata is separate from potentially large history and output.
pub struct AgentTaskRow {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub state: Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retiring_agent_step_limits_preserves_tasks_history_and_results() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agents.sqlite");
        let store = Store::open(&path).unwrap();
        let workspace = store.create_workspace("/project", "project").unwrap();
        let session = store.create_session(&workspace.id, "agents").unwrap();
        let mut expected = Vec::new();
        for (index, budget) in [Some(json!(14)), Some(json!(64)), Some(Value::Null), None]
            .into_iter()
            .enumerate()
        {
            let id = format!("agent_{index}");
            let mut state = json!({
                "status": "failed",
                "error": "previous failure",
                "request": {"prompt": "continue", "model": "test-model"},
                "heldMessages": ["pending instruction"],
                "progress": {"step": 14},
            });
            if let Some(budget) = budget {
                state["request"]["maxTurns"] = budget;
            }
            let history = json!([
                {"role": "user", "content": "完整任务"},
                {"role": "tool", "content": {"maxTurns": 64, "result": "kept"}}
            ]);
            store
                .create_agent_task(&AgentTaskRow {
                    id: id.clone(),
                    session_id: session.id.clone(),
                    name: id.clone(),
                    parent_id: None,
                    created_at: "before".into(),
                    state: state.clone(),
                })
                .unwrap();
            store
                .save_agent_task(
                    &session.id,
                    &id,
                    &state,
                    Some(&history),
                    Some(Some("partial result")),
                )
                .unwrap();
            state["request"].as_object_mut().unwrap().remove("maxTurns");
            expected.push((id, state, history));
        }
        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "DELETE FROM schema_migrations WHERE name = '0031_agent_step_limits'",
                [],
            )
            .unwrap();
        drop(store);

        // Opening applies the migration once; reopening keeps the same data.
        for _ in 0..2 {
            let store = Store::open(&path).unwrap();
            let rows = store.list_agent_tasks(&session.id).unwrap();
            assert_eq!(rows.len(), expected.len());
            for (row, (id, state, history)) in rows.iter().zip(&expected) {
                assert_eq!(&row.id, id);
                assert_eq!(row.name, *id);
                assert_eq!(row.session_id, session.id);
                assert_eq!(row.created_at, "before");
                assert_eq!(row.parent_id, None);
                assert_eq!(&row.state, state);
                assert_eq!(
                    store.agent_history(&session.id, id).unwrap().as_ref(),
                    Some(history)
                );
                assert_eq!(
                    store.agent_result(&session.id, id).unwrap().as_deref(),
                    Some("partial result")
                );
                let revision: i64 = store
                    .conn
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT history_revision FROM agent_tasks WHERE id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(revision, 1);
            }
        }
    }
}

impl Store {
    pub fn create_agent_task(&self, row: &AgentTaskRow) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO agent_tasks (id, session_id, name, parent_id, created_at, state_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                row.id,
                row.session_id,
                row.name,
                row.parent_id,
                row.created_at,
                serde_json::to_string(&row.state)?
            ],
        )?;
        Ok(())
    }

    pub fn list_agent_tasks(&self, session_id: &str) -> Result<Vec<AgentTaskRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, parent_id, created_at, state_json
             FROM agent_tasks WHERE session_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (id, name, parent_id, created_at, raw) = row?;
            Ok(AgentTaskRow {
                id,
                session_id: session_id.into(),
                name,
                parent_id,
                created_at,
                state: serde_json::from_str(&raw)?,
            })
        })
        .collect()
    }

    /// Checkpoint data and lifecycle changes commit atomically. None retains
    /// the previous payload; Some(None) explicitly clears a previous result.
    pub fn save_agent_task(
        &self,
        session_id: &str,
        id: &str,
        state: &Value,
        history: Option<&Value>,
        result: Option<Option<&str>>,
    ) -> Result<()> {
        let state_json = serde_json::to_string(state)?;
        let history_json = history.map(serde_json::to_string).transpose()?;
        let changed = self.conn.lock().unwrap().execute(
            "UPDATE agent_tasks SET state_json = ?3,
             history_json = CASE WHEN ?4 IS NULL THEN history_json ELSE ?4 END,
             history_revision = history_revision + CASE WHEN ?4 IS NULL THEN 0 ELSE 1 END,
             result = CASE WHEN ?5 THEN ?6 ELSE result END
             WHERE session_id = ?1 AND id = ?2",
            params![
                session_id,
                id,
                state_json,
                history_json,
                result.is_some(),
                result.flatten()
            ],
        )?;
        if changed != 1 {
            return Err(MemoryError::NotFound(format!("agent: {id}")));
        }
        Ok(())
    }

    pub fn agent_history(&self, session_id: &str, id: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT history_json FROM agent_tasks WHERE session_id = ?1 AND id = ?2",
                params![session_id, id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("agent: {id}")))?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }

    pub fn agent_result(&self, session_id: &str, id: &str) -> Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT result FROM agent_tasks WHERE session_id = ?1 AND id = ?2",
                params![session_id, id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("agent: {id}")))
    }

    pub fn delete_agent_task(&self, session_id: &str, id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM agent_tasks WHERE session_id = ?1 AND id = ?2",
            params![session_id, id],
        )?;
        Ok(())
    }
}
