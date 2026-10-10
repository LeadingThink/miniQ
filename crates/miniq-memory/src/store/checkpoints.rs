//! File checkpoints: a backup taken before each write-type tool runs, plus
//! the file state recorded right after the tool finished.

use rusqlite::{params, OptionalExtension, Row};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::{new_id, now_iso, CheckpointRow, MemoryError, Result, Store};

const CHECKPOINT_COLUMNS: &str =
    "id, session_id, tool_call_id, abs_path, existed, backup_path, created_at, after_state";

fn row_to_checkpoint(row: &Row<'_>) -> rusqlite::Result<CheckpointRow> {
    Ok(CheckpointRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        tool_call_id: row.get(2)?,
        abs_path: row.get(3)?,
        existed: row.get::<_, i64>(4)? != 0,
        backup_path: row.get(5)?,
        created_at: row.get(6)?,
        after_state: row.get(7)?,
    })
}

/// Checkpoints of one user turn (a user message up to the next one).
#[derive(Debug, Clone, Default)]
pub struct TurnCheckpoints {
    /// Checkpoints created during the turn, oldest first.
    pub within: Vec<CheckpointRow>,
    /// Checkpoints created after the turn ended, oldest first.
    pub after: Vec<CheckpointRow>,
}

fn parse_time(value: &str) -> Result<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|error| MemoryError::InvalidData(format!("timestamp {value}: {error}")))
}

impl Store {
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
            after_state: None,
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

    /// Record the file state after the checkpointed tool call finished.
    pub fn set_checkpoint_after_state(&self, id: &str, after_state: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE checkpoints SET after_state = ?2 WHERE id = ?1",
            params![id, after_state],
        )?;
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("checkpoint {id}")));
        }
        Ok(())
    }

    pub fn get_checkpoint(&self, id: &str) -> Result<CheckpointRow> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = ?1"),
            params![id],
            row_to_checkpoint,
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("checkpoint {id}")))
    }

    pub fn list_checkpoints(&self, session_id: &str) -> Result<Vec<CheckpointRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHECKPOINT_COLUMNS} FROM checkpoints
             WHERE session_id = ?1 ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = stmt.query_map(params![session_id], row_to_checkpoint)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// File checkpoints recorded by tool calls at or after a user message,
    /// oldest first. Undo restores them newest first.
    pub fn checkpoints_since_user_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Vec<CheckpointRow>> {
        let conn = self.conn.lock().unwrap();
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM messages WHERE id = ?1 AND session_id = ?2 AND role = 'user'",
                params![message_id, session_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("user message {message_id}")))?;
        let columns = CHECKPOINT_COLUMNS
            .split(", ")
            .map(|column| format!("c.{column}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT {columns}
             FROM checkpoints c JOIN tool_calls t ON t.id = c.tool_call_id
             WHERE c.session_id = ?1 AND t.session_id = ?1 AND t.created_at >= ?2
             ORDER BY c.created_at ASC, c.id ASC"
        ))?;
        let rows = stmt.query_map(params![session_id, created_at], row_to_checkpoint)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Checkpoints split around the turn started by `message_id`. The turn
    /// ends at the next user message. Timestamps are compared as instants so
    /// differing fractional-second precision cannot misorder them.
    pub fn turn_checkpoints(&self, session_id: &str, message_id: &str) -> Result<TurnCheckpoints> {
        let user_messages = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, created_at FROM messages
                 WHERE session_id = ?1 AND role = 'user' ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map(params![session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut starts = user_messages
            .iter()
            .map(|(id, created_at)| Ok((parse_time(created_at)?, id.as_str())))
            .collect::<Result<Vec<_>>>()?;
        starts.sort_by_key(|(at, _)| *at);
        let index = starts
            .iter()
            .position(|(_, id)| *id == message_id)
            .ok_or_else(|| MemoryError::NotFound(format!("user message {message_id}")))?;
        let start = starts[index].0;
        let end = starts.get(index + 1).map(|(at, _)| *at);
        let mut turn = TurnCheckpoints::default();
        for checkpoint in self.list_checkpoints(session_id)? {
            let at = parse_time(&checkpoint.created_at)?;
            if at < start {
                continue;
            }
            if end.is_some_and(|end| at >= end) {
                turn.after.push(checkpoint);
            } else {
                turn.within.push(checkpoint);
            }
        }
        Ok(turn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::{Role, ToolCallStatus};
    use serde_json::json;

    fn tool_call(store: &Store, session_id: &str) -> String {
        store
            .create_tool_call(
                session_id,
                "file_write",
                &json!({}),
                None,
                ToolCallStatus::Succeeded,
            )
            .unwrap()
            .id
    }

    #[test]
    fn turn_checkpoints_split_at_the_next_user_message() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/turn-ckpt", "ws").unwrap();
        let session = store.create_session(&workspace.id, "s").unwrap();
        let first = store
            .append_message(&session.id, Role::User, "first")
            .unwrap();
        let call = tool_call(&store, &session.id);
        let a = store
            .create_checkpoint(&session.id, &call, "/tmp/a", false, None)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = store
            .append_message(&session.id, Role::User, "second")
            .unwrap();
        let call = tool_call(&store, &session.id);
        let b = store
            .create_checkpoint(&session.id, &call, "/tmp/a", true, None)
            .unwrap();
        store.set_checkpoint_after_state(&b.id, "absent").unwrap();

        let turn = store.turn_checkpoints(&session.id, &first.id).unwrap();
        assert_eq!(
            turn.within.iter().map(|c| &c.id).collect::<Vec<_>>(),
            [&a.id]
        );
        assert_eq!(
            turn.after.iter().map(|c| &c.id).collect::<Vec<_>>(),
            [&b.id]
        );

        let last = store.turn_checkpoints(&session.id, &second.id).unwrap();
        assert_eq!(last.within.len(), 1);
        assert_eq!(last.within[0].after_state.as_deref(), Some("absent"));
        assert!(last.after.is_empty());
        assert!(store.turn_checkpoints(&session.id, "missing").is_err());
    }
}
