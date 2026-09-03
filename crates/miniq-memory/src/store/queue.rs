//! Queued user messages: sent while a turn was active, drained when it ends.

use miniq_protocol::{MessageAttachment, QueuedMessage};
use rusqlite::{params, OptionalExtension};

use super::{new_id, now_iso, MemoryError, Result, Store};

fn row_to_queued(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueuedMessage> {
    let attachments_json: String = row.get(3)?;
    Ok(QueuedMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        content: row.get(2)?,
        attachments: serde_json::from_str(&attachments_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        position: row.get(4)?,
        created_at: row.get(5)?,
    })
}

impl Store {
    /// Append a message to the end of the session's queue.
    pub fn enqueue_message(&self, session_id: &str, content: &str) -> Result<QueuedMessage> {
        self.enqueue_message_with_attachments(session_id, content, &[])
    }

    pub fn enqueue_message_with_attachments(
        &self,
        session_id: &str,
        content: &str,
        attachments: &[MessageAttachment],
    ) -> Result<QueuedMessage> {
        let conn = self.conn.lock().unwrap();
        let position: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM queued_messages WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        let message = QueuedMessage {
            id: new_id("qmsg"),
            session_id: session_id.to_string(),
            content: content.to_string(),
            attachments: attachments.to_vec(),
            position,
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO queued_messages
               (id, session_id, content, attachments_json, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                message.id,
                message.session_id,
                message.content,
                serde_json::to_string(&message.attachments)?,
                message.position,
                message.created_at
            ],
        )?;
        Ok(message)
    }

    /// All queued messages for a session in execution order.
    pub fn list_queued_messages(&self, session_id: &str) -> Result<Vec<QueuedMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, content, attachments_json, position, created_at
             FROM queued_messages WHERE session_id = ?1 ORDER BY position ASC",
        )?;
        let rows = stmt.query_map(params![session_id], row_to_queued)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Remove and return the first queued message, if any.
    pub fn dequeue_message(&self, session_id: &str) -> Result<Option<QueuedMessage>> {
        let conn = self.conn.lock().unwrap();
        let message = conn
            .query_row(
                "SELECT id, session_id, content, attachments_json, position, created_at
                 FROM queued_messages WHERE session_id = ?1
                 ORDER BY position ASC LIMIT 1",
                params![session_id],
                row_to_queued,
            )
            .optional()?;
        if let Some(message) = &message {
            conn.execute(
                "DELETE FROM queued_messages WHERE id = ?1",
                params![message.id],
            )?;
        }
        Ok(message)
    }

    /// Remove one queued message by id (user removed it from the queue).
    pub fn remove_queued_message(&self, id: &str) -> Result<QueuedMessage> {
        let conn = self.conn.lock().unwrap();
        let message = conn
            .query_row(
                "SELECT id, session_id, content, attachments_json, position, created_at
                 FROM queued_messages WHERE id = ?1",
                params![id],
                row_to_queued,
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("queued message {id}")))?;
        conn.execute("DELETE FROM queued_messages WHERE id = ?1", params![id])?;
        Ok(message)
    }

    /// Move a queued message to the front (position before the current head).
    pub fn promote_queued_message(&self, id: &str) -> Result<QueuedMessage> {
        let conn = self.conn.lock().unwrap();
        let message = conn
            .query_row(
                "SELECT id, session_id, content, attachments_json, position, created_at
                 FROM queued_messages WHERE id = ?1",
                params![id],
                row_to_queued,
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("queued message {id}")))?;
        let head: i64 = conn.query_row(
            "SELECT COALESCE(MIN(position), 1) FROM queued_messages WHERE session_id = ?1",
            params![message.session_id],
            |row| row.get(0),
        )?;
        let new_position = head - 1;
        conn.execute(
            "UPDATE queued_messages SET position = ?2 WHERE id = ?1",
            params![id, new_position],
        )?;
        Ok(QueuedMessage {
            position: new_position,
            ..message
        })
    }

    /// Drop every queued message for a session (e.g. user pressed stop).
    pub fn clear_queued_messages(&self, session_id: &str) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let removed = conn.execute(
            "DELETE FROM queued_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_session() -> (Store, String) {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/queue-test", "queue").unwrap();
        let session = store.create_session(&workspace.id, "queued").unwrap();
        (store, session.id)
    }

    #[test]
    fn enqueue_and_dequeue_in_order() {
        let (store, session_id) = store_with_session();
        store.enqueue_message(&session_id, "first").unwrap();
        store.enqueue_message(&session_id, "second").unwrap();

        let queued = store.list_queued_messages(&session_id).unwrap();
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].content, "first");

        let head = store.dequeue_message(&session_id).unwrap().unwrap();
        assert_eq!(head.content, "first");
        let head = store.dequeue_message(&session_id).unwrap().unwrap();
        assert_eq!(head.content, "second");
        assert!(store.dequeue_message(&session_id).unwrap().is_none());
    }

    #[test]
    fn promote_moves_message_to_front() {
        let (store, session_id) = store_with_session();
        store.enqueue_message(&session_id, "first").unwrap();
        let second = store.enqueue_message(&session_id, "second").unwrap();

        store.promote_queued_message(&second.id).unwrap();

        let head = store.dequeue_message(&session_id).unwrap().unwrap();
        assert_eq!(head.content, "second");
    }

    #[test]
    fn remove_and_clear() {
        let (store, session_id) = store_with_session();
        let first = store.enqueue_message(&session_id, "first").unwrap();
        store.enqueue_message(&session_id, "second").unwrap();

        store.remove_queued_message(&first.id).unwrap();
        assert_eq!(store.list_queued_messages(&session_id).unwrap().len(), 1);

        store.clear_queued_messages(&session_id).unwrap();
        assert!(store.list_queued_messages(&session_id).unwrap().is_empty());
    }
}
