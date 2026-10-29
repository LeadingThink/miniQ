use super::{memory_index, memory_write, MemoryError, MemoryRow, Result, Store};
use miniq_protocol::{MemoryCursor, MemoryDeleteParams, MemoryListParams, MemoryTarget};
use rusqlite::{params, Connection, OptionalExtension};

pub(super) const COLUMNS: &str = "m.id, m.workspace_id, m.scope, m.content, m.created_at, m.updated_at, m.revision, m.kind, m.fact_key, m.origin";
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPage {
    pub memories: Vec<MemoryRow>,
    pub next_cursor: Option<MemoryCursor>,
}
pub(super) fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    let kind: String = row.get(7)?;
    Ok(MemoryRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        revision: row.get(6)?,
        kind: serde_json::from_value(kind.into()).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(e))
        })?,
        key: row.get(8)?,
        origin: row.get(9)?,
    })
}
pub(super) fn validate_target(conn: &Connection, target: &MemoryTarget) -> Result<()> {
    if let MemoryTarget::Workspace { workspace_id } = target {
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
            [workspace_id],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(MemoryError::NotFound(format!("workspace {workspace_id}")));
        }
    }
    Ok(())
}
pub(super) fn get(conn: &Connection, id: &str) -> Result<Option<MemoryRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM memories m WHERE m.id=?1"),
            [id],
            row,
        )
        .optional()?)
}
impl Store {
    pub fn search_memories(
        &self,
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRow>> {
        if !(1..=100).contains(&limit) {
            return Err(MemoryError::InvalidData(
                "memory limit must be between 1 and 100".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        if let Some(id) = workspace_id {
            validate_target(
                &conn,
                &MemoryTarget::Workspace {
                    workspace_id: id.into(),
                },
            )?;
        }
        memory_index::search(&conn, workspace_id, query, limit)
    }
    pub fn list_memories(&self, input: &MemoryListParams) -> Result<MemoryPage> {
        if !(1..=100).contains(&input.limit) {
            return Err(MemoryError::InvalidData(
                "memory limit must be between 1 and 100".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        validate_target(&conn, &input.target)?;
        let (scope, workspace_id) = input.target.parts();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM memories m WHERE scope=?1 AND workspace_id IS ?2 AND instr(lower(content), lower(?3))>0
             AND (?4 IS NULL OR updated_at < ?4 OR (updated_at=?4 AND id < ?5))
             ORDER BY updated_at DESC, id DESC LIMIT ?6"))?;
        let mut memories = stmt
            .query_map(
                params![
                    scope,
                    workspace_id,
                    input.query,
                    input.before.as_ref().map(|c| &c.updated_at),
                    input.before.as_ref().map(|c| &c.id),
                    i64::from(input.limit) + 1
                ],
                row,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let next_cursor = if memories.len() > input.limit as usize {
            memories.pop();
            memories.last().map(|m| MemoryCursor {
                updated_at: m.updated_at.clone(),
                id: m.id.clone(),
            })
        } else {
            None
        };
        Ok(MemoryPage {
            memories,
            next_cursor,
        })
    }
    pub fn delete_memory(&self, input: &MemoryDeleteParams) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        validate_target(&tx, &input.target)?;
        let item = get(&tx, &input.id)?.ok_or_else(|| {
            MemoryError::InvalidData(
                "memory is no longer available; refresh before deleting".into(),
            )
        })?;
        let (scope, workspace) = input.target.parts();
        if item.scope != scope
            || item.workspace_id.as_deref() != workspace
            || item.updated_at != input.expected_updated_at
            || item.content != input.expected_content
        {
            return Err(MemoryError::InvalidData(
                "memory changed or is not in this scope; refresh before deleting".into(),
            ));
        }
        memory_write::forget(&tx, &item)?;
        tx.commit()?;
        Ok(())
    }
    pub fn memory_by_id(&self, target: &MemoryTarget, id: &str) -> Result<Option<MemoryRow>> {
        let conn = self.conn.lock().unwrap();
        validate_target(&conn, target)?;
        let (scope, workspace) = target.parts();
        Ok(get(&conn, id)?.filter(|m| m.scope == scope && m.workspace_id.as_deref() == workspace))
    }
    pub fn rebuild_memory_index(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        memory_index::rebuild(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn memory_sources(
        &self,
        target: &MemoryTarget,
        id: &str,
    ) -> Result<Vec<miniq_protocol::MemorySource>> {
        let conn = self.conn.lock().unwrap();
        validate_target(&conn, target)?;
        let (scope, workspace) = target.parts();
        let mut stmt = conn.prepare("SELECT msg.session_id,s.message_id,s.content_hash,s.byte_start,s.byte_end
            FROM memory_sources s JOIN memories m ON m.id=s.memory_id JOIN messages msg ON msg.id=s.message_id
            WHERE m.id=?1 AND m.scope=?2 AND m.workspace_id IS ?3 AND s.revision=m.revision ORDER BY s.message_id")?;
        let sources = stmt
            .query_map(params![id, scope, workspace], |r| {
                Ok(miniq_protocol::MemorySource {
                    session_id: r.get(0)?,
                    message_id: r.get(1)?,
                    content_hash: r.get(2)?,
                    byte_start: r.get(3)?,
                    byte_end: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(sources)
    }
}
#[cfg(test)]
#[path = "memories_tests.rs"]
mod tests;
