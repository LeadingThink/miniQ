use super::{params, Result, Store};

const SESSION_ATTACHMENT_EXISTS: &str = "
    SELECT EXISTS (
        SELECT 1 FROM messages m, json_each(m.attachments_json) a
        WHERE m.session_id = ?1 AND json_extract(a.value, '$.path') = ?2
        UNION ALL
        SELECT 1 FROM queued_messages q, json_each(q.attachments_json) a
        WHERE q.session_id = ?1 AND json_extract(a.value, '$.path') = ?2
    )";

impl Store {
    /// Exact attachment ownership, without loading message contents or history.
    /// The caller must canonicalize the requested file before comparing paths.
    pub fn session_has_attachment(&self, session_id: &str, path: &str) -> Result<bool> {
        Ok(self.conn.lock().unwrap().query_row(
            SESSION_ATTACHMENT_EXISTS,
            params![session_id, path],
            |row| row.get(0),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::{MessageAttachment, Role};

    #[test]
    fn attachment_ownership_is_exact_and_tracks_queue_to_history() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/project", "test").unwrap();
        let first = store.create_session(&workspace.id, "first").unwrap();
        let second = store.create_session(&workspace.id, "second").unwrap();
        let attachment = MessageAttachment {
            path: "/private/data/attachments/one.png".into(),
            name: "one.png".into(),
            mime_type: Some("image/png".into()),
        };
        let queued = store
            .enqueue_message_with_attachments(&first.id, "queued", &[attachment.clone()])
            .unwrap();
        assert!(store
            .session_has_attachment(&first.id, &attachment.path)
            .unwrap());
        assert!(!store
            .session_has_attachment(&second.id, &attachment.path)
            .unwrap());
        assert!(!store
            .session_has_attachment(&first.id, "/private/data/attachments")
            .unwrap());
        assert!(!store
            .session_has_attachment(&first.id, "/private/data/attachments/one.png.bak")
            .unwrap());
        store.remove_queued_message(&queued.id).unwrap();
        assert!(!store
            .session_has_attachment(&first.id, &attachment.path)
            .unwrap());
        store
            .enqueue_message_with_attachments(&first.id, "queued again", &[attachment.clone()])
            .unwrap();
        store.start_queued_message(&first.id).unwrap().unwrap();
        assert!(store
            .session_has_attachment(&first.id, &attachment.path)
            .unwrap());
        store
            .append_message_with_attachments(
                &second.id,
                Role::User,
                "explicitly shared",
                &[attachment.clone()],
            )
            .unwrap();
        assert!(store
            .session_has_attachment(&second.id, &attachment.path)
            .unwrap());
    }

    #[test]
    fn ownership_lookup_uses_session_indexes_for_both_tables() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn.lock().unwrap();
        let mut statement = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {SESSION_ATTACHMENT_EXISTS}"))
            .unwrap();
        let plan = statement
            .query_map(params!["session", "/file.png"], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n");
        assert!(plan.contains("idx_messages_session"), "{plan}");
        assert!(plan.contains("idx_queued_messages_session"), "{plan}");
    }
}
