use miniq_protocol::Artifact;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{new_id, now_iso, CheckpointRow, MemoryError, MemoryRow, Result, Store};

impl Store {
    pub fn create_artifact(
        &self,
        session_id: &str,
        path: &str,
        kind: &str,
        title: &str,
    ) -> Result<Artifact> {
        let conn = self.conn.lock().unwrap();
        let artifact = Artifact {
            id: new_id("art"),
            session_id: session_id.to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO artifacts (id, session_id, path, kind, title, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                artifact.id,
                artifact.session_id,
                artifact.path,
                artifact.kind,
                artifact.title,
                artifact.created_at
            ],
        )?;
        Ok(artifact)
    }

    pub fn list_artifacts(&self, session_id: &str) -> Result<Vec<Artifact>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, path, kind, title, created_at
             FROM artifacts WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Artifact {
                id: row.get(0)?,
                session_id: row.get(1)?,
                path: row.get(2)?,
                kind: row.get(3)?,
                title: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn create_checkpoint(
        &self,
        session_id: &str,
        tool_call_id: &str,
        abs_path: &str,
        existed: bool,
        backup_path: Option<&str>,
    ) -> Result<CheckpointRow> {
        let conn = self.conn.lock().unwrap();
        let checkpoint = CheckpointRow {
            id: new_id("ckpt"),
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            abs_path: abs_path.to_string(),
            existed,
            backup_path: backup_path.map(|path| path.to_string()),
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO checkpoints (id, session_id, tool_call_id, abs_path, existed, backup_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                checkpoint.id,
                checkpoint.session_id,
                checkpoint.tool_call_id,
                checkpoint.abs_path,
                checkpoint.existed as i64,
                checkpoint.backup_path,
                checkpoint.created_at
            ],
        )?;
        Ok(checkpoint)
    }

    pub fn get_checkpoint(&self, id: &str) -> Result<CheckpointRow> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, session_id, tool_call_id, abs_path, existed, backup_path, created_at
             FROM checkpoints WHERE id = ?1",
            params![id],
            |row| {
                Ok(CheckpointRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    tool_call_id: row.get(2)?,
                    abs_path: row.get(3)?,
                    existed: row.get::<_, i64>(4)? != 0,
                    backup_path: row.get(5)?,
                    created_at: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("checkpoint {id}")))
    }

    pub fn create_memory(
        &self,
        workspace_id: Option<&str>,
        scope: &str,
        content: &str,
    ) -> Result<MemoryRow> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let memory = MemoryRow {
            id: new_id("mem"),
            workspace_id: workspace_id.map(|id| id.to_string()),
            scope: scope.to_string(),
            content: content.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO memories (id, workspace_id, scope, content, metadata_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6)",
            params![
                memory.id,
                memory.workspace_id,
                memory.scope,
                memory.content,
                memory.created_at,
                memory.updated_at
            ],
        )?;
        Ok(memory)
    }

    /// Substring search over memories visible to a workspace: its own rows
    /// plus global-scope rows.
    pub fn search_memories(
        &self,
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRow>> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, scope, content, created_at, updated_at FROM memories
             WHERE content LIKE ?1 ESCAPE '\\'
               AND (scope = 'global' OR workspace_id IS ?2 OR ?2 IS NULL)
             ORDER BY updated_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![pattern, workspace_id, limit as i64], |row| {
            Ok(MemoryRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                scope: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn append_audit_event(
        &self,
        session_id: Option<&str>,
        event_type: &str,
        payload: &Value,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO audit_events (id, session_id, event_type, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                new_id("audit"),
                session_id,
                event_type,
                serde_json::to_string(payload)?,
                now_iso()
            ],
        )?;
        Ok(())
    }

    pub fn count_audit_events(&self, session_id: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let count = conn.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }
}
