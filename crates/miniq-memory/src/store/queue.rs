//! Queued user messages: sent while a turn was active, drained when it ends.

use miniq_protocol::{Message, MessageAttachment, QueuedMessage, Role};
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
    /// Check pending work without loading any message payloads.
    pub fn has_queued_messages(&self) -> Result<bool> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM queued_messages)",
            [],
            |row| row.get(0),
        )?)
    }

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

    /// Edit only a still-pending message, under the same lock as queue draining.
    /// Compare the original content to avoid overwriting another client's edit.
    /// Attachments, identity, timestamp and execution order remain unchanged.
    pub fn update_queued_message(
        &self,
        session_id: &str,
        id: &str,
        expected_content: &str,
        content: &str,
    ) -> Result<QueuedMessage> {
        let conn = self.conn.lock().unwrap();
        let mut message = conn
            .query_row(
                "SELECT id, session_id, content, attachments_json, position, created_at
                 FROM queued_messages WHERE id = ?1 AND session_id = ?2",
                params![id, session_id],
                row_to_queued,
            )
            .optional()?
            .ok_or_else(|| {
                MemoryError::NotFound("排队消息已开始执行或已被移除，请保留编辑内容".into())
            })?;
        if message.content != expected_content {
            return Err(MemoryError::InvalidData(
                "这条排队消息已在其他设备更新，请查看最新内容后再编辑".into(),
            ));
        }
        let content = content.trim();
        if content.is_empty() && message.attachments.is_empty() {
            return Err(MemoryError::InvalidData("消息内容不能为空".into()));
        }
        conn.execute(
            "UPDATE queued_messages SET content = ?2 WHERE id = ?1",
            params![id, content],
        )?;
        message.content = content.into();
        Ok(message)
    }

    /// Move the queue head into conversation history and record its origin in
    /// one transaction. Failed persistence leaves the original queue untouched.
    pub fn start_queued_message(&self, session_id: &str) -> Result<Option<Message>> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let queued = transaction
            .query_row(
                "SELECT id, session_id, content, attachments_json, position, created_at
                 FROM queued_messages WHERE session_id = ?1
                 ORDER BY position ASC, id ASC LIMIT 1",
                params![session_id],
                row_to_queued,
            )
            .optional()?;
        let Some(queued) = queued else {
            return Ok(None);
        };
        let message = Message {
            id: new_id("msg"),
            session_id: session_id.into(),
            role: Role::User,
            content: queued.content,
            attachments: queued.attachments,
            created_at: now_iso(),
        };
        super::conversation::insert_message(&transaction, &message)?;
        transaction.execute(
            "INSERT INTO audit_events (id, session_id, event_type, payload_json, created_at)
             VALUES (?1, ?2, 'queued_message_started', ?3, ?4)",
            params![new_id("audit"), session_id, serde_json::json!({
                "sourceMessageId": message.id, "queuedMessageId": queued.id, "queuedAt": queued.created_at,
            }).to_string(), message.created_at],
        )?;
        transaction.execute(
            "DELETE FROM queued_messages WHERE id = ?1",
            params![queued.id],
        )?;
        transaction.commit()?;
        Ok(Some(message))
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
    fn edit_preserves_identity_attachments_order_and_executes_the_saved_content() {
        let (store, session_id) = store_with_session();
        store.enqueue_message(&session_id, "first").unwrap();
        let attachments = vec![MessageAttachment {
            path: "/tmp/report.pdf".into(),
            name: "report.pdf".into(),
            mime_type: None,
        }];
        let queued = store
            .enqueue_message_with_attachments(&session_id, "original", &attachments)
            .unwrap();
        let edited = store
            .update_queued_message(&session_id, &queued.id, "original", "  new\n完整内容  ")
            .unwrap();
        assert_eq!(edited.id, queued.id);
        assert_eq!(edited.position, queued.position);
        assert_eq!(edited.created_at, queued.created_at);
        assert_eq!(edited.attachments[0].path, attachments[0].path);
        assert_eq!(
            store.list_queued_messages(&session_id).unwrap()[1].content,
            "new\n完整内容"
        );
        assert_eq!(
            store
                .start_queued_message(&session_id)
                .unwrap()
                .unwrap()
                .content,
            "first"
        );
        let started = store.start_queued_message(&session_id).unwrap().unwrap();
        assert_eq!(started.content, "new\n完整内容");
        assert_eq!(started.attachments[0].path, attachments[0].path);
        assert!(store
            .update_queued_message(&session_id, &queued.id, &edited.content, "too late")
            .is_err());
        assert_eq!(
            store.list_messages(&session_id).unwrap()[1].content,
            edited.content
        );
    }

    #[test]
    fn edit_rejects_cross_session_stale_or_blank_updates_without_mutating_queue() {
        let (store, session_id) = store_with_session();
        let queued = store.enqueue_message(&session_id, "original").unwrap();
        for (session, expected, content) in [
            ("other-session", "original", "cross-session"),
            (session_id.as_str(), "stale", "would overwrite"),
            (session_id.as_str(), "original", " \n "),
        ] {
            assert!(store
                .update_queued_message(session, &queued.id, expected, content)
                .is_err());
            assert_eq!(
                store.list_queued_messages(&session_id).unwrap()[0].content,
                "original"
            );
        }
        store
            .update_queued_message(&session_id, &queued.id, "original", "mobile edit")
            .unwrap();
        assert!(store
            .update_queued_message(&session_id, &queued.id, "original", "desktop edit")
            .is_err());
        assert_eq!(
            store.list_queued_messages(&session_id).unwrap()[0].content,
            "mobile edit"
        );
        store.remove_queued_message(&queued.id).unwrap();
        assert!(store
            .update_queued_message(&session_id, &queued.id, "mobile edit", "too late")
            .is_err());
        assert!(store.list_queued_messages(&session_id).unwrap().is_empty());
    }

    #[test]
    fn attachment_only_queue_edit_survives_store_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.sqlite");
        let store = Store::open(&path).unwrap();
        let workspace = store
            .create_workspace("/tmp/queue-persist", "persist")
            .unwrap();
        let session = store.create_session(&workspace.id, "queue").unwrap();
        let attachments = vec![MessageAttachment {
            path: "/tmp/pic.png".into(),
            name: "pic.png".into(),
            mime_type: None,
        }];
        let queued = store
            .enqueue_message_with_attachments(&session.id, "caption", &attachments)
            .unwrap();
        store
            .update_queued_message(&session.id, &queued.id, "caption", "")
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        let queue = store.list_queued_messages(&session.id).unwrap();
        assert_eq!(queue[0].id, queued.id);
        assert!(queue[0].content.is_empty());
        assert_eq!(queue[0].attachments[0].path, "/tmp/pic.png");
    }

    #[test]
    fn enqueue_and_dequeue_in_order() {
        let (store, session_id) = store_with_session();
        store.enqueue_message(&session_id, "first").unwrap();
        store.enqueue_message(&session_id, "second").unwrap();

        let queued = store.list_queued_messages(&session_id).unwrap();
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].content, "first");

        let head = store.start_queued_message(&session_id).unwrap().unwrap();
        assert_eq!(head.content, "first");
        let head = store.start_queued_message(&session_id).unwrap().unwrap();
        assert_eq!(head.content, "second");
        assert!(store.start_queued_message(&session_id).unwrap().is_none());
        assert_eq!(store.list_messages(&session_id).unwrap().len(), 2);
    }

    #[test]
    fn promote_moves_message_to_front() {
        let (store, session_id) = store_with_session();
        store.enqueue_message(&session_id, "first").unwrap();
        let second = store.enqueue_message(&session_id, "second").unwrap();

        store.promote_queued_message(&second.id).unwrap();

        let head = store.start_queued_message(&session_id).unwrap().unwrap();
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

    #[test]
    fn failed_history_or_origin_write_retains_queue_identity_content_and_attachments() {
        for table in ["messages", "audit_events"] {
            let (store, session_id) = store_with_session();
            let attachments = vec![MessageAttachment {
                path: "/tmp/evidence.png".into(),
                name: "evidence.png".into(),
                mime_type: Some("image/png".into()),
            }];
            let queued = store
                .enqueue_message_with_attachments(
                    &session_id,
                    "keep this instruction",
                    &attachments,
                )
                .unwrap();
            store.conn.lock().unwrap().execute_batch(&format!(
                "CREATE TRIGGER injected_failure BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
            )).unwrap();
            assert!(store.start_queued_message(&session_id).is_err());
            let still_queued = store.list_queued_messages(&session_id).unwrap();
            assert_eq!(still_queued[0].id, queued.id);
            assert_eq!(still_queued[0].content, queued.content);
            assert_eq!(still_queued[0].attachments[0].path, attachments[0].path);
            assert!(store.list_messages(&session_id).unwrap().is_empty());
            assert_eq!(store.count_audit_events(&session_id).unwrap(), 0);
            store
                .conn
                .lock()
                .unwrap()
                .execute_batch("DROP TRIGGER injected_failure")
                .unwrap();
            let message = store.start_queued_message(&session_id).unwrap().unwrap();
            let raw: String = store.conn.lock().unwrap().query_row(
                "SELECT payload_json FROM audit_events WHERE session_id = ?1 AND event_type = 'queued_message_started'",
                params![session_id], |row| row.get(0),
            ).unwrap();
            let origin: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(origin["sourceMessageId"], message.id);
            assert_eq!(origin["queuedMessageId"], queued.id);
            assert_eq!(origin["queuedAt"], queued.created_at);
            assert_eq!(message.attachments[0].path, attachments[0].path);
        }
    }
}
