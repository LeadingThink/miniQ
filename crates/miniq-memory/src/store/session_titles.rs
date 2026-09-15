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
        self.write_automatic_title(source, title, false)
    }

    /// Persist a usable title before contacting the model, while keeping the
    /// summary pending. Only the display title is shortened; messages are intact.
    pub fn apply_fallback_title(&self, source: &Message) -> Result<Option<String>> {
        let title = fallback_title(source);
        Ok(self
            .write_automatic_title(source, &title, true)?
            .then_some(title))
    }

    fn write_automatic_title(&self, source: &Message, title: &str, pending: bool) -> Result<bool> {
        Ok(self.conn.lock().unwrap().execute(
            "UPDATE sessions SET title = ?2, title_auto_pending = ?6
             WHERE id = ?1 AND title_auto_pending = 1 AND (title <> ?2 OR ?6 = 0) AND EXISTS (
               SELECT 1 FROM messages WHERE session_id = ?1 AND id = ?3
               AND content = ?4 AND attachments_json = ?5 AND role = 'user'
               AND rowid = (SELECT MIN(rowid) FROM messages WHERE session_id = ?1 AND role = 'user')
             )",
            params![
                source.session_id,
                title,
                source.id,
                source.content,
                serde_json::to_string(&source.attachments)?,
                pending
            ],
        )? == 1)
    }
}

fn fallback_title(source: &Message) -> String {
    let content = source
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let content = if content.is_empty() {
        source.attachments.first().map_or_else(
            || "新会话".to_owned(),
            |attachment| format!("附件：{}", attachment.name),
        )
    } else {
        content
    };
    let mut chars = content.chars();
    let mut title: String = chars.by_ref().take(24).collect();
    if chars.next().is_some() {
        title.push('…');
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::Role;

    fn fixture(content: &str) -> (Store, Message) {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/title-test", "test").unwrap();
        let session = store.create_session(&workspace.id, "New session").unwrap();
        store.enable_automatic_title(&session.id).unwrap();
        let message = store
            .append_message(&session.id, Role::User, content)
            .unwrap();
        (store, message)
    }

    #[test]
    fn automatic_title_applies_once_without_reordering_the_session() {
        let (store, source) = fixture("整理简历");
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
        let (store, source) = fixture("整理简历");
        store
            .update_session_title(&source.session_id, "我的标题")
            .unwrap();
        assert!(!store.apply_automatic_title(&source, "迟到结果").unwrap());
        assert!(store.apply_fallback_title(&source).unwrap().is_none());
        assert!(store
            .automatic_title_source(&source.session_id)
            .unwrap()
            .is_none());
        store.delete_session(&source.session_id).unwrap();
        assert!(!store.apply_automatic_title(&source, "迟到结果").unwrap());
        assert!(store.apply_fallback_title(&source).unwrap().is_none());
    }

    #[test]
    fn changed_source_content_cannot_apply_a_stale_title() {
        let (store, mut source) = fixture("整理简历");
        source.content = "另一个请求".into();
        assert!(!store.apply_automatic_title(&source, "无效结果").unwrap());
        assert!(store.apply_fallback_title(&source).unwrap().is_none());
    }

    #[test]
    fn fallback_is_immediate_persistent_and_replaceable_without_changing_the_message() {
        let content = "请".repeat(30);
        let (store, source) = fixture(&content);
        let before = store.get_session(&source.session_id).unwrap();
        let expected = format!("{}…", "请".repeat(24));
        assert_eq!(
            store.apply_fallback_title(&source).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(
            store.get_session(&source.session_id).unwrap().title,
            expected
        );
        assert_eq!(
            store.get_session(&source.session_id).unwrap().updated_at,
            before.updated_at
        );
        assert_eq!(
            store
                .automatic_title_source(&source.session_id)
                .unwrap()
                .unwrap()
                .content,
            content
        );
        assert!(store.apply_fallback_title(&source).unwrap().is_none());

        assert!(store.apply_automatic_title(&source, "整理简历").unwrap());
        assert!(store.apply_fallback_title(&source).unwrap().is_none());
        assert_eq!(
            store.get_session(&source.session_id).unwrap().title,
            "整理简历"
        );
        assert_eq!(
            store.list_messages(&source.session_id).unwrap()[0].content,
            content
        );
    }

    #[test]
    fn fallback_uses_24_unicode_characters_and_normalizes_whitespace() {
        let (_, mut source) = fixture("\n 请整理\t所有材料\r\n 谢谢  ");
        assert_eq!(fallback_title(&source), "请整理 所有材料 谢谢");
        source.content = "中".repeat(24);
        assert_eq!(fallback_title(&source), source.content);
        source.content.push('🙂');
        assert_eq!(fallback_title(&source), format!("{}…", "中".repeat(24)));
        source.content = "🙂".repeat(24);
        assert_eq!(fallback_title(&source), source.content);
        source.content.clear();
        source.attachments.push(miniq_protocol::MessageAttachment {
            path: "/tmp/report.pdf".into(),
            name: "报告.pdf".into(),
            mime_type: None,
        });
        assert_eq!(fallback_title(&source), "附件：报告.pdf");
    }

    #[test]
    fn identical_summary_finalizes_pending_title_and_later_messages_cannot_replace_it() {
        let (store, source) = fixture("整理简历");
        store.apply_fallback_title(&source).unwrap();
        let later = store
            .append_message(&source.session_id, Role::User, "再写一封邮件")
            .unwrap();
        assert!(store.apply_fallback_title(&later).unwrap().is_none());
        assert!(store.apply_automatic_title(&source, "整理简历").unwrap());
        assert!(store
            .automatic_title_source(&source.session_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn rewriting_first_request_updates_fallback_and_rejects_the_previous_source() {
        let (store, original) = fixture("整理简历");
        store.apply_fallback_title(&original).unwrap();
        let updated = store
            .rewrite_session_from_user_message(&original.session_id, &original.id, "整理合同", &[])
            .unwrap()
            .message;
        assert_eq!(
            store.apply_fallback_title(&updated).unwrap(),
            Some("整理合同".into())
        );
        assert!(!store.apply_automatic_title(&original, "旧标题").unwrap());
        assert!(store.apply_fallback_title(&original).unwrap().is_none());
        assert_eq!(
            store.get_session(&original.session_id).unwrap().title,
            "整理合同"
        );
    }
}
