use miniq_protocol::{Session, SessionStatus, Workspace};
use rusqlite::{params, OptionalExtension};

use super::row_mappers::{row_to_session, row_to_workspace};
use super::{new_id, now_iso, MemoryError, Result, Store};

impl Store {
    pub fn create_workspace(&self, path: &str, name: &str) -> Result<Workspace> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        if let Some(workspace) = conn
            .query_row(
                "SELECT id, path, name, created_at, updated_at FROM workspaces WHERE path = ?1",
                params![path],
                row_to_workspace,
            )
            .optional()?
        {
            return Ok(workspace);
        }
        let workspace = Workspace {
            id: new_id("ws"),
            path: path.to_string(),
            name: name.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO workspaces (id, path, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workspace.id,
                workspace.path,
                workspace.name,
                workspace.created_at,
                workspace.updated_at
            ],
        )?;
        Ok(workspace)
    }

    pub fn get_workspace(&self, id: &str) -> Result<Workspace> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, path, name, created_at, updated_at FROM workspaces WHERE id = ?1",
            params![id],
            row_to_workspace,
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("workspace {id}")))
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, path, name, created_at, updated_at FROM workspaces ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_workspace)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn create_session(&self, workspace_id: &str, title: &str) -> Result<Session> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let session = Session {
            id: new_id("sess"),
            workspace_id: workspace_id.to_string(),
            title: title.to_string(),
            status: SessionStatus::Idle,
            pinned: false,
            external: None,
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, title, status, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                session.id,
                session.workspace_id,
                session.title,
                session.status.as_str(),
                session.pinned as i32,
                session.created_at,
                session.updated_at
            ],
        )?;
        Ok(session)
    }

    pub fn get_session(&self, id: &str) -> Result<Session> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT s.id, s.workspace_id, s.title, s.status, s.created_at, s.updated_at,
                    s.pinned,
                    e.provider, e.external_id, e.source_path, e.continuation_mode,
                    e.imported_at, e.last_synced_at
             FROM sessions s
             LEFT JOIN external_session_links e ON e.session_id = s.id
             WHERE s.id = ?1",
            params![id],
            row_to_session,
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("session {id}")))
    }

    pub fn list_sessions(&self, workspace_id: Option<&str>) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        match workspace_id {
            Some(workspace_id) => {
                let mut stmt = conn.prepare(
                    "SELECT s.id, s.workspace_id, s.title, s.status, s.created_at, s.updated_at,
                            s.pinned,
                            e.provider, e.external_id, e.source_path, e.continuation_mode,
                            e.imported_at, e.last_synced_at
                     FROM sessions s
                     LEFT JOIN external_session_links e ON e.session_id = s.id
                     WHERE s.workspace_id = ?1
                     ORDER BY s.pinned DESC, s.updated_at DESC",
                )?;
                let rows = stmt.query_map(params![workspace_id], row_to_session)?;
                Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT s.id, s.workspace_id, s.title, s.status, s.created_at, s.updated_at,
                            s.pinned,
                            e.provider, e.external_id, e.source_path, e.continuation_mode,
                            e.imported_at, e.last_synced_at
                     FROM sessions s
                     LEFT JOIN external_session_links e ON e.session_id = s.id
                     ORDER BY s.pinned DESC, s.updated_at DESC",
                )?;
                let rows = stmt.query_map([], row_to_session)?;
                Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
            }
        }
    }

    pub fn update_session_status(&self, id: &str, status: SessionStatus) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE sessions SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status.as_str(), now_iso()],
        )?;
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn update_session_title(&self, id: &str, title: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE sessions SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now_iso()],
        )?;
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn set_session_pinned(&self, id: &str, pinned: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Never touch updated_at — keep the original session timestamp so the
        // item returns to its chronological position after being unpinned and
        // the displayed time stays consistent.
        let updated = conn.execute(
            "UPDATE sessions SET pinned = ?2 WHERE id = ?1",
            params![id, pinned as i32],
        )?;
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn update_workspace_name(&self, id: &str, name: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE workspaces SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now_iso()],
        )?;
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("workspace {id}")));
        }
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Verify the session exists first.
        let exists: bool = conn
            .query_row("SELECT 1 FROM sessions WHERE id = ?1", params![id], |_| {
                Ok(true)
            })
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(MemoryError::NotFound(format!("session {id}")));
        }
        // Delete in dependency order. external_session_links and
        // external_session_events use ON DELETE CASCADE so they are
        // handled automatically when the session row is removed.
        conn.execute("DELETE FROM approvals WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM tool_calls WHERE session_id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM model_context_snapshots WHERE session_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM messages WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM artifacts WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM checkpoints WHERE session_id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM audit_events WHERE session_id = ?1",
            params![id],
        )?;
        // Finally delete the session itself (cascades to external_session_*).
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete a workspace and all its sessions (with full cascade).
    /// Returns an error if any session in the workspace is currently running.
    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Verify the workspace exists.
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM workspaces WHERE id = ?1",
                params![id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(MemoryError::NotFound(format!("workspace {id}")));
        }
        // Refuse to delete if any session is running or cancelling.
        let busy: bool = conn
            .query_row(
                "SELECT 1 FROM sessions WHERE workspace_id = ?1 \
                 AND status IN ('running', 'cancelling') LIMIT 1",
                params![id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if busy {
            return Err(MemoryError::NotFound(format!(
                "workspace {id} has running sessions"
            )));
        }
        // Collect all session IDs for this workspace.
        let session_ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM sessions WHERE workspace_id = ?1")?;
            let rows = stmt.query_map(params![id], |row| row.get(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        // Delete workspace-level dependents first.
        conn.execute(
            "DELETE FROM scheduled_tasks WHERE workspace_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM memories WHERE workspace_id = ?1", params![id])?;
        // Delete session-level dependents.
        for sid in &session_ids {
            conn.execute("DELETE FROM approvals WHERE session_id = ?1", params![sid])?;
            conn.execute("DELETE FROM tool_calls WHERE session_id = ?1", params![sid])?;
            conn.execute(
                "DELETE FROM model_context_snapshots WHERE session_id = ?1",
                params![sid],
            )?;
            conn.execute("DELETE FROM messages WHERE session_id = ?1", params![sid])?;
            conn.execute("DELETE FROM artifacts WHERE session_id = ?1", params![sid])?;
            conn.execute(
                "DELETE FROM checkpoints WHERE session_id = ?1",
                params![sid],
            )?;
            conn.execute(
                "DELETE FROM audit_events WHERE session_id = ?1",
                params![sid],
            )?;
        }
        // Delete all sessions (cascades to external_session_*).
        conn.execute("DELETE FROM sessions WHERE workspace_id = ?1", params![id])?;
        // Finally delete the workspace itself.
        conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }
}
