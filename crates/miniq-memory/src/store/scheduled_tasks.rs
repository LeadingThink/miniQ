use miniq_protocol::ScheduledTask;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::row_mappers::row_to_scheduled_task;
use super::{new_id, now_iso, MemoryError, Result, Store};

impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn create_scheduled_task(
        &self,
        workspace_id: &str,
        name: &str,
        prompt: &str,
        schedule: &Value,
        next_run_at: &str,
    ) -> Result<ScheduledTask> {
        let conn = self.conn.lock().unwrap();
        let task = ScheduledTask {
            id: new_id("sched"),
            workspace_id: workspace_id.to_string(),
            name: name.to_string(),
            prompt: prompt.to_string(),
            schedule: schedule.clone(),
            enabled: true,
            next_run_at: next_run_at.to_string(),
            last_run_at: None,
            last_session_id: None,
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO scheduled_tasks
               (id, workspace_id, name, prompt, schedule, enabled, next_run_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
            params![
                task.id,
                task.workspace_id,
                task.name,
                task.prompt,
                serde_json::to_string(&task.schedule)?,
                task.next_run_at,
                task.created_at
            ],
        )?;
        Ok(task)
    }

    pub fn list_scheduled_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_session_id, created_at
             FROM scheduled_tasks ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_scheduled_task)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_scheduled_task(&self, id: &str) -> Result<ScheduledTask> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_session_id, created_at
             FROM scheduled_tasks WHERE id = ?1",
            params![id],
            row_to_scheduled_task,
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("scheduled task {id}")))
    }

    /// Enabled tasks whose next_run_at is at or before `now` (RFC3339 UTC).
    pub fn due_scheduled_tasks(&self, now: &str) -> Result<Vec<ScheduledTask>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_session_id, created_at
             FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now], row_to_scheduled_task)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Record a run: bump last_run/last_session and set the next due time.
    pub fn mark_scheduled_task_run(
        &self,
        id: &str,
        session_id: &str,
        next_run_at: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE scheduled_tasks
             SET last_run_at = ?2, last_session_id = ?3, next_run_at = ?4 WHERE id = ?1",
            params![id, now_iso(), session_id, next_run_at],
        )?;
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("scheduled task {id}")));
        }
        Ok(())
    }

    /// Enable/disable; enabling recomputes next_run_at (passed by the caller).
    pub fn set_scheduled_task_enabled(
        &self,
        id: &str,
        enabled: bool,
        next_run_at: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = match next_run_at {
            Some(next_run_at) => conn.execute(
                "UPDATE scheduled_tasks SET enabled = ?2, next_run_at = ?3 WHERE id = ?1",
                params![id, enabled, next_run_at],
            )?,
            None => conn.execute(
                "UPDATE scheduled_tasks SET enabled = ?2 WHERE id = ?1",
                params![id, enabled],
            )?,
        };
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("scheduled task {id}")));
        }
        Ok(())
    }

    pub fn delete_scheduled_task(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute("DELETE FROM scheduled_tasks WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Err(MemoryError::NotFound(format!("scheduled task {id}")));
        }
        Ok(())
    }
}
