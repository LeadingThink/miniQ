use miniq_protocol::{MemoryCursor, MemoryDeleteParams, MemoryListParams, MemoryTarget};
use rusqlite::{params, Connection};

use super::{new_id, now_iso, MemoryError, MemoryRow, Result, Store};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPage {
    pub memories: Vec<MemoryRow>,
    pub next_cursor: Option<MemoryCursor>,
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    Ok(MemoryRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn search_pattern(query: &str) -> String {
    format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn validate_target(conn: &Connection, target: &MemoryTarget) -> Result<()> {
    if let MemoryTarget::Workspace { workspace_id } = target {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
            [workspace_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(MemoryError::NotFound(format!("workspace {workspace_id}")));
        }
    }
    Ok(())
}

impl Store {
    pub fn create_memory(
        &self,
        workspace_id: Option<&str>,
        scope: &str,
        content: &str,
    ) -> Result<MemoryRow> {
        let target = match (scope, workspace_id) {
            ("workspace", Some(id)) if !id.is_empty() => MemoryTarget::Workspace {
                workspace_id: id.into(),
            },
            ("global", None) => MemoryTarget::Global {},
            _ => {
                return Err(MemoryError::InvalidData(
                    "memory scope and workspace do not match".into(),
                ))
            }
        };
        if content.trim().is_empty() {
            return Err(MemoryError::InvalidData("memory content is empty".into()));
        }
        let conn = self.conn.lock().unwrap();
        validate_target(&conn, &target)?;
        let now = now_iso();
        let memory = MemoryRow {
            id: new_id("mem"),
            workspace_id: workspace_id.map(str::to_owned),
            scope: scope.into(),
            content: content.into(),
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO memories (id, workspace_id, scope, content, metadata_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6)",
            params![memory.id, memory.workspace_id, memory.scope, memory.content, memory.created_at, memory.updated_at],
        )?;
        Ok(memory)
    }

    /// Agent search combines this workspace and global memory. Without an open
    /// workspace, only global memories are visible.
    pub fn search_memories(
        &self,
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRow>> {
        let conn = self.conn.lock().unwrap();
        if let Some(id) = workspace_id {
            validate_target(
                &conn,
                &MemoryTarget::Workspace {
                    workspace_id: id.into(),
                },
            )?;
        }
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, scope, content, created_at, updated_at FROM memories
             WHERE content LIKE ?1 ESCAPE '\\'
               AND ((scope = 'global' AND workspace_id IS NULL)
                    OR (scope = 'workspace' AND workspace_id = ?2))
             ORDER BY updated_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![search_pattern(query), workspace_id, limit as i64],
            row,
        )?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
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
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, scope, content, created_at, updated_at FROM memories
             WHERE scope = ?1 AND workspace_id IS ?2 AND content LIKE ?3 ESCAPE '\\'
               AND (?4 IS NULL OR updated_at < ?4 OR (updated_at = ?4 AND id < ?5))
             ORDER BY updated_at DESC, id DESC LIMIT ?6",
        )?;
        let rows = stmt.query_map(
            params![
                scope,
                workspace_id,
                search_pattern(&input.query),
                input.before.as_ref().map(|cursor| &cursor.updated_at),
                input.before.as_ref().map(|cursor| &cursor.id),
                i64::from(input.limit) + 1
            ],
            row,
        )?;
        let mut memories = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        let next_cursor = if memories.len() > input.limit as usize {
            // The extra row only detects another page; its data remains reachable via the cursor.
            memories.pop();
            memories.last().map(|item| MemoryCursor {
                updated_at: item.updated_at.clone(),
                id: item.id.clone(),
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
        let conn = self.conn.lock().unwrap();
        validate_target(&conn, &input.target)?;
        let (scope, workspace_id) = input.target.parts();
        let deleted = conn.execute(
            "DELETE FROM memories WHERE id = ?1 AND scope = ?2 AND workspace_id IS ?3 AND updated_at = ?4 AND content = ?5",
            params![input.id, scope, workspace_id, input.expected_updated_at, input.expected_content],
        )?;
        if deleted == 0 {
            return Err(MemoryError::InvalidData(
                "memory changed or is no longer available in this scope; refresh before deleting"
                    .into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "memories_tests.rs"]
mod tests;
