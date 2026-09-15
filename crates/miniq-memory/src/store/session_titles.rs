use miniq_protocol::Message;
use rusqlite::{params, OptionalExtension};

use super::{row_mappers::row_to_message, Result, Store};

impl Store {
    pub fn enable_automatic_title(&self, session_id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE sessions SET title_auto_pending = 1 WHERE id = ?1",
            [session_id],
        )?;
        Ok(())
    }

    /// The original request, not the whole transcript or private tool outputs.
    pub fn automatic_title_source(&self, session_id: &str) -> Result<Option<Message>> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT m.id, m.session_id, m.role, m.content, m.attachments_json, m.created_at
             FROM messages m JOIN sessions s ON s.id = m.session_id
             WHERE s.id = ?1 AND s.title_auto_pending = 1 AND m.role = 'user'
             ORDER BY m.rowid LIMIT 1",
                [session_id],
                row_to_message,
            )
            .optional()?)
    }

    /// One atomic write: a rename, deletion, rewrite, or another title result
    /// that arrived during inference must win over this stale background job.
    pub fn apply_automatic_title(&self, source: &Message, title: &str) -> Result<bool> {
        Ok(self.conn.lock().unwrap().execute(
            "UPDATE sessions SET title = ?2, title_auto_pending = 0
             WHERE id = ?1 AND title_auto_pending = 1 AND EXISTS (
               SELECT 1 FROM messages WHERE session_id = ?1 AND id = ?3
               AND content = ?4 AND attachments_json = ?5 AND role = 'user'
               AND rowid = (SELECT MIN(rowid) FROM messages WHERE session_id = ?1 AND role = 'user')
             )",
            params![
                source.session_id,
                title,
                source.id,
                source.content,
                serde_json::to_string(&source.attachments)?
            ],
        )? == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::Role;

    fn fixture() -> (Store, Message) {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/title-test", "test").unwrap();
        let session = store.create_session(&workspace.id, "New session").unwrap();
        store.enable_automatic_title(&session.id).unwrap();
        let message = store
            .append_message(&session.id, Role::User, "整理简历")
            .unwrap();
        (store, message)
    }

    #[test]
    fn automatic_title_applies_once_without_reordering_the_session() {
        let (store, source) = fixture();
        let before = store.get_session(&source.session_id).unwrap();
        assert_eq!(
            store
                .automatic_title_source(&source.session_id)
                .unwrap()
                .unwrap()
                .id,
            source.id
        );
        assert!(store.apply_automatic_title(&source, "筛选候选人").unwrap());
        assert!(!store.apply_automatic_title(&source, "迟到结果").unwrap());
        let after = store.get_session(&source.session_id).unwrap();
        assert_eq!(after.title, "筛选候选人");
        assert_eq!(after.updated_at, before.updated_at);
    }

    #[test]
    fn manual_rename_or_deleted_session_wins_over_a_pending_title() {
        let (store, source) = fixture();
        store
            .update_session_title(&source.session_id, "我的标题")
            .unwrap();
        assert!(!store.apply_automatic_title(&source, "迟到结果").unwrap());
        assert!(store
            .automatic_title_source(&source.session_id)
            .unwrap()
            .is_none());
        store.delete_session(&source.session_id).unwrap();
        assert!(!store.apply_automatic_title(&source, "迟到结果").unwrap());
    }

    #[test]
    fn changed_source_content_cannot_apply_a_stale_title() {
        let (store, mut source) = fixture();
        source.content = "另一个请求".into();
        assert!(!store.apply_automatic_title(&source, "无效结果").unwrap());
    }
}
