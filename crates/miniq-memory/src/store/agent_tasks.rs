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
        let changed = self.conn.lock().unwrap().execute(
            "UPDATE agent_tasks SET state_json = ?3,
             history_json = CASE WHEN ?4 IS NULL THEN history_json ELSE ?4 END,
             history_revision = history_revision + CASE WHEN ?4 IS NULL THEN 0 ELSE 1 END,
             result = CASE WHEN ?5 THEN ?6 ELSE result END
             WHERE session_id = ?1 AND id = ?2",
            params![
                session_id,
                id,
                serde_json::to_string(state)?,
                history.map(serde_json::to_string).transpose()?,
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
