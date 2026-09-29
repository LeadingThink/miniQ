use miniq_protocol::Session;
use rusqlite::{params, Row};

use super::row_mappers::row_to_session;
use super::{Result, Store};

/// Maximum characters in a `session.list` preview, including the ellipsis.
const PREVIEW_CHARS: usize = 80;

/// One statement returns sessions plus their list summaries. The correlated
/// subqueries all use `idx_messages_session`, so there is no per-session
/// round trip. Only a bounded prefix of the newest message is read because
/// the preview is a one-line display summary.
const LIST_SESSIONS_SQL: &str = "
SELECT s.id, s.workspace_id, s.title, s.status, s.created_at, s.updated_at,
       s.pinned, s.archived,
       e.provider, e.external_id, e.source_path, e.continuation_mode,
       e.imported_at, e.last_synced_at, s.working_directory,
       (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id),
       (SELECT substr(ltrim(m.content, ' ' || char(9, 10, 13)), 1, 1000)
          FROM messages m
         WHERE m.session_id = s.id
           AND m.role IN ('user', 'assistant')
           AND trim(m.content, ' ' || char(9, 10, 13)) <> ''
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT 1),
       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user')
FROM sessions s
LEFT JOIN external_session_links e ON e.session_id = s.id
WHERE ?1 IS NULL OR s.workspace_id = ?1
ORDER BY s.pinned DESC, s.updated_at DESC";

impl Store {
    /// Sessions for the sidebar, with `last_activity_at`, `preview` and
    /// `turn_count` populated.
    pub fn list_sessions(&self, workspace_id: Option<&str>) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(LIST_SESSIONS_SQL)?;
        let rows = stmt.query_map(params![workspace_id], row_to_listed_session)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

fn row_to_listed_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    let mut session = row_to_session(row)?;
    session.last_activity_at = row.get(15)?;
    let preview: Option<String> = row.get(16)?;
    session.preview = preview.as_deref().and_then(preview_line);
    let turn_count: i64 = row.get(17)?;
    session.turn_count = Some(u32::try_from(turn_count).unwrap_or(u32::MAX));
    Ok(session)
}

/// Collapses all whitespace (including newlines) into single spaces and
/// shortens to [`PREVIEW_CHARS`], marking the cut with an ellipsis.
fn preview_line(content: &str) -> Option<String> {
    let line = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= PREVIEW_CHARS {
        return Some(line);
    }
    let mut short: String = line.chars().take(PREVIEW_CHARS - 1).collect();
    short.truncate(short.trim_end().len());
    short.push('…');
    Some(short)
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::Role;

    #[test]
    fn preview_is_single_trimmed_line_capped_at_80_chars() {
        assert_eq!(preview_line("  hi\n\n there\t"), Some("hi there".into()));
        assert_eq!(preview_line(" \n "), None);
        let long = "字".repeat(200);
        let preview = preview_line(&long).unwrap();
        assert_eq!(preview.chars().count(), PREVIEW_CHARS);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn list_sessions_includes_summaries_from_one_query() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/list-summary", "ws").unwrap();
        let other = store.create_workspace("/tmp/list-other", "other").unwrap();
        let busy = store.create_session(&workspace.id, "busy").unwrap();
        let empty = store.create_session(&workspace.id, "empty").unwrap();
        store.create_session(&other.id, "elsewhere").unwrap();
        store.append_message(&busy.id, Role::User, "first").unwrap();
        store
            .append_message(&busy.id, Role::Assistant, "reply")
            .unwrap();
        store
            .append_message(&busy.id, Role::User, "second")
            .unwrap();
        let last = store
            .append_message(&busy.id, Role::Assistant, "  done\nwith   it  ")
            .unwrap();
        store
            .append_message(&busy.id, Role::Tool, "tool noise")
            .unwrap();

        let sessions = store.list_sessions(Some(&workspace.id)).unwrap();
        assert_eq!(sessions.len(), 2);
        let busy = sessions.iter().find(|s| s.id == busy.id).unwrap();
        assert_eq!(busy.turn_count, Some(2));
        assert_eq!(busy.preview.as_deref(), Some("done with it"));
        assert!(busy.last_activity_at.as_deref() >= Some(last.created_at.as_str()));
        let empty = sessions.iter().find(|s| s.id == empty.id).unwrap();
        assert_eq!(empty.turn_count, Some(0));
        assert_eq!(empty.preview, None);
        assert_eq!(empty.last_activity_at, None);
        assert_eq!(store.list_sessions(None).unwrap().len(), 3);
    }
}
