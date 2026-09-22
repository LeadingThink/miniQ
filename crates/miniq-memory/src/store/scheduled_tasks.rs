use miniq_protocol::{Message, Role, ScheduledTask, ScheduledTaskMode};
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
        mode: ScheduledTaskMode,
        target_session_id: Option<&str>,
        memory: &str,
    ) -> Result<ScheduledTask> {
        let conn = self.conn.lock().unwrap();
        let task = ScheduledTask {
            id: new_id("sched"),
            workspace_id: workspace_id.to_string(),
            name: name.to_string(),
            prompt: prompt.to_string(),
            mode,
            target_session_id: target_session_id.map(str::to_string),
            memory: memory.to_string(),
            schedule: schedule.clone(),
            enabled: true,
            next_run_at: next_run_at.to_string(),
            last_run_at: None,
            last_session_id: None,
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO scheduled_tasks
               (id, workspace_id, name, prompt, mode, target_session_id, memory, schedule, enabled, next_run_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10)",
            params![
                task.id,
                task.workspace_id,
                task.name,
                task.prompt,
                task.mode.as_str(),
                task.target_session_id,
                task.memory,
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
                    last_run_at, last_session_id, created_at, mode, target_session_id, memory
             FROM scheduled_tasks ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_scheduled_task)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_scheduled_task(&self, id: &str) -> Result<ScheduledTask> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_session_id, created_at, mode, target_session_id, memory
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
                    last_run_at, last_session_id, created_at, mode, target_session_id, memory
             FROM scheduled_tasks WHERE enabled = 1 AND dispatching = 0 AND next_run_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now], row_to_scheduled_task)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Commit the prompt and dispatch record together before starting model work.
    pub fn start_scheduled_task_run(
        &self,
        id: &str,
        session_id: &str,
        content: &str,
        next_run_at: &str,
    ) -> Result<Message> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let updated = transaction.execute(
            "UPDATE scheduled_tasks
             SET last_run_at = ?2, last_session_id = ?3, next_run_at = ?4, dispatching = 0
             WHERE id = ?1 AND (dispatching = 1 OR (dispatching = 2 AND enabled = 1))
             AND EXISTS (SELECT 1 FROM sessions WHERE id = ?3
                 AND workspace_id = scheduled_tasks.workspace_id
                 AND status IN ('idle', 'failed'))
             AND (mode = 'newSession' OR (mode = 'heartbeat' AND target_session_id = ?3))",
            params![id, now_iso(), session_id, next_run_at],
        )?;
        if updated == 0 {
            return Err(MemoryError::InvalidData(
                "任务已变更、暂停，或目标会话不再可用，请刷新后重试".into(),
            ));
        }
        let message = Message {
            id: new_id("msg"),
            session_id: session_id.to_owned(),
            role: Role::User,
            content: content.to_owned(),
            attachments: Vec::new(),
            created_at: now_iso(),
            turn_timing: None,
        };
        super::conversation::insert_message(&transaction, &message)?;
        transaction.execute(
            "UPDATE sessions SET status = 'running' WHERE id = ?1",
            params![session_id],
        )?;
        transaction.commit()?;
        Ok(message)
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

    /// Atomically claim a due task so a scheduler tick and a manual run cannot
    /// dispatch it twice concurrently.
    pub fn claim_scheduled_task(&self, id: &str, due_at: Option<&str>) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE scheduled_tasks SET dispatching = CASE WHEN ?2 IS NULL THEN 1 ELSE 2 END
             WHERE id = ?1 AND dispatching = 0
             AND (?2 IS NULL OR (enabled = 1 AND next_run_at = ?2 AND next_run_at <= ?3))
             AND (mode = 'newSession' OR NOT EXISTS (
                 SELECT 1 FROM sessions WHERE id = scheduled_tasks.last_session_id
                 AND status IN ('running', 'waiting_approval', 'cancelling')
             ))",
            params![id, due_at, now_iso()],
        )? == 1)
    }

    /// A process can stop between claiming and recording a dispatch. No claim
    /// survives daemon startup; committed runs are protected by their session.
    pub fn recover_scheduled_task_claims(&self) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE scheduled_tasks SET dispatching = 0", [])?;
        Ok(())
    }

    pub fn release_scheduled_task(&self, id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE scheduled_tasks SET dispatching = 0 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Skip a still-current occurrence without changing the user's enabled
    /// state or overwriting a manual run/edit that already advanced it.
    pub fn defer_scheduled_task(&self, id: &str, due_at: &str, next_run_at: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE scheduled_tasks SET next_run_at = ?3
             WHERE id = ?1 AND enabled = 1 AND dispatching = 0 AND next_run_at = ?2",
            params![id, due_at, next_run_at],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_scheduled_task(
        &self,
        id: &str,
        workspace_id: &str,
        name: &str,
        prompt: &str,
        schedule: &Value,
        mode: ScheduledTaskMode,
        target_session_id: Option<&str>,
        memory: &str,
        next_run_at: &str,
    ) -> Result<ScheduledTask> {
        let conn = self.conn.lock().unwrap();
        let dispatching: i64 = conn
            .query_row(
                "SELECT dispatching FROM scheduled_tasks WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("scheduled task {id}")))?;
        if dispatching != 0 {
            return Err(MemoryError::InvalidData("任务正在启动，请稍后编辑".into()));
        }
        let changed = conn.execute(
            "UPDATE scheduled_tasks SET workspace_id=?2, name=?3, prompt=?4, schedule=?5, mode=?6,
             target_session_id=?7, memory=?8, next_run_at=?9 WHERE id=?1 AND dispatching=0",
            params![
                id,
                workspace_id,
                name,
                prompt,
                serde_json::to_string(schedule)?,
                mode.as_str(),
                target_session_id,
                memory,
                next_run_at
            ],
        )?;
        if changed == 0 {
            return Err(MemoryError::NotFound(format!("scheduled task {id}")));
        }
        drop(conn);
        self.get_scheduled_task(id)
    }
}

#[cfg(test)]
mod tests;
