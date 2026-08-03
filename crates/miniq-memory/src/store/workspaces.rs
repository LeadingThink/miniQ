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
            external: None,
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session.id,
                session.workspace_id,
                session.title,
                session.status.as_str(),
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
                            e.provider, e.external_id, e.source_path, e.continuation_mode,
                            e.imported_at, e.last_synced_at
                     FROM sessions s
                     LEFT JOIN external_session_links e ON e.session_id = s.id
                     WHERE s.workspace_id = ?1 ORDER BY s.updated_at DESC",
                )?;
                let rows = stmt.query_map(params![workspace_id], row_to_session)?;
                Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT s.id, s.workspace_id, s.title, s.status, s.created_at, s.updated_at,
                            e.provider, e.external_id, e.source_path, e.continuation_mode,
                            e.imported_at, e.last_synced_at
                     FROM sessions s
                     LEFT JOIN external_session_links e ON e.session_id = s.id
                     ORDER BY s.updated_at DESC",
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
}
