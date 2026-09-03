use miniq_protocol::{ExternalSessionSnapshot, Session, SessionStatus};
use rusqlite::{params, OptionalExtension, Transaction};

use super::row_mappers::row_to_session;
use super::{new_id, now_iso, Result, Store};

#[derive(Debug)]
pub struct ExternalImportOutcome {
    pub session: Session,
    pub imported_messages: usize,
    pub created: bool,
}

impl Store {
    pub fn import_external_session(
        &self,
        workspace_id: &str,
        snapshot: &ExternalSessionSnapshot,
    ) -> Result<ExternalImportOutcome> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let existing_id = find_external_session(&transaction, snapshot)?;
        let created = existing_id.is_none();
        let session_id = existing_id.unwrap_or_else(|| new_id("sess"));
        let synced_at = now_iso();
        if created {
            insert_session(
                &transaction,
                &session_id,
                workspace_id,
                snapshot,
                &synced_at,
            )?;
        } else {
            update_session_title(&transaction, &session_id, snapshot)?;
        }
        upsert_link(&transaction, &session_id, snapshot, &synced_at)?;
        insert_events(&transaction, &session_id, snapshot)?;
        let imported_messages = project_messages(&transaction, &session_id, snapshot, &synced_at)?;
        if imported_messages > 0 && !created {
            transaction.execute(
                "UPDATE sessions
                 SET updated_at = CASE WHEN updated_at > ?2 THEN updated_at ELSE ?2 END
                 WHERE id = ?1",
                params![session_id, synced_at],
            )?;
        }
        let session = read_session(&transaction, &session_id)?;
        transaction.commit()?;
        Ok(ExternalImportOutcome {
            session,
            imported_messages,
            created,
        })
    }
}

fn find_external_session(
    transaction: &Transaction<'_>,
    snapshot: &ExternalSessionSnapshot,
) -> Result<Option<String>> {
    transaction
        .query_row(
            "SELECT session_id FROM external_session_links WHERE provider = ?1 AND external_id = ?2",
            params![snapshot.summary.provider.as_str(), snapshot.summary.external_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn insert_session(
    transaction: &Transaction<'_>,
    session_id: &str,
    workspace_id: &str,
    snapshot: &ExternalSessionSnapshot,
    now: &str,
) -> Result<()> {
    let created_at = snapshot.summary.created_at.as_deref().unwrap_or(now);
    let updated_at = snapshot.summary.updated_at.as_deref().unwrap_or(created_at);
    transaction.execute(
        "INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            session_id,
            workspace_id,
            snapshot.summary.title,
            SessionStatus::Idle.as_str(),
            created_at,
            updated_at
        ],
    )?;
    Ok(())
}

fn update_session_title(
    transaction: &Transaction<'_>,
    session_id: &str,
    snapshot: &ExternalSessionSnapshot,
) -> Result<()> {
    transaction.execute(
        "UPDATE sessions SET title = ?2 WHERE id = ?1",
        params![session_id, snapshot.summary.title],
    )?;
    Ok(())
}

fn upsert_link(
    transaction: &Transaction<'_>,
    session_id: &str,
    snapshot: &ExternalSessionSnapshot,
    now: &str,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO external_session_links (
            session_id, provider, external_id, source_path, continuation_mode, imported_at, last_synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
            source_path = excluded.source_path,
            continuation_mode = excluded.continuation_mode,
            last_synced_at = excluded.last_synced_at",
        params![
            session_id,
            snapshot.summary.provider.as_str(),
            snapshot.summary.external_id,
            snapshot.summary.source_path,
            snapshot.summary.continuation_mode.as_str(),
            now
        ],
    )?;
    Ok(())
}

fn insert_events(
    transaction: &Transaction<'_>,
    session_id: &str,
    snapshot: &ExternalSessionSnapshot,
) -> Result<()> {
    for event in &snapshot.events {
        transaction.execute(
            "INSERT OR IGNORE INTO external_session_events (
                session_id, event_id, sequence, event_type, payload_json, occurred_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session_id,
                event.event_id,
                event.sequence,
                event.event_type,
                serde_json::to_string(&event.payload)?,
                event.occurred_at
            ],
        )?;
    }
    Ok(())
}

fn project_messages(
    transaction: &Transaction<'_>,
    session_id: &str,
    snapshot: &ExternalSessionSnapshot,
    now: &str,
) -> Result<usize> {
    let mut imported = 0;
    for message in &snapshot.messages {
        let projected: Option<String> = transaction
            .query_row(
                "SELECT projected_message_id FROM external_session_events
                 WHERE session_id = ?1 AND event_id = ?2",
                params![session_id, message.event_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if projected.is_some() {
            continue;
        }
        let message_id = new_id("msg");
        transaction.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                message_id,
                session_id,
                message.role.as_str(),
                message.content,
                message.occurred_at.as_deref().unwrap_or(now)
            ],
        )?;
        transaction.execute(
            "UPDATE external_session_events SET projected_message_id = ?3
             WHERE session_id = ?1 AND event_id = ?2",
            params![session_id, message.event_id, message_id],
        )?;
        imported += 1;
    }
    Ok(imported)
}

fn read_session(transaction: &Transaction<'_>, session_id: &str) -> Result<Session> {
    transaction
        .query_row(
            "SELECT s.id, s.workspace_id, s.title, s.status, s.created_at, s.updated_at,
                    s.pinned, s.archived,
                    e.provider, e.external_id, e.source_path, e.continuation_mode,
                    e.imported_at, e.last_synced_at
             FROM sessions s
             LEFT JOIN external_session_links e ON e.session_id = s.id
             WHERE s.id = ?1",
            params![session_id],
            row_to_session,
        )
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use miniq_protocol::{
        ExternalContinuationMode, ExternalProvider, ExternalSessionEvent, ExternalSessionMessage,
        ExternalSessionSnapshot, ExternalSessionSummary, Role,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn import_is_idempotent_and_preserves_raw_payload() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("C:/work", "work").unwrap();
        let snapshot = snapshot();

        let first = store
            .import_external_session(&workspace.id, &snapshot)
            .unwrap();
        assert!(first.created);
        assert_eq!(first.imported_messages, 2);
        assert_eq!(
            first.session.external.as_ref().unwrap().external_id,
            "external-1"
        );

        store
            .append_message(&first.session.id, Role::User, "continue in miniQ")
            .unwrap();
        let second = store
            .import_external_session(&workspace.id, &snapshot)
            .unwrap();
        assert!(!second.created);
        assert_eq!(second.imported_messages, 0);
        assert_eq!(store.list_messages(&first.session.id).unwrap().len(), 3);

        let mut renamed = snapshot.clone();
        renamed.summary.title = "Updated provider title".to_owned();
        let renamed_outcome = store
            .import_external_session(&workspace.id, &renamed)
            .unwrap();
        assert_eq!(renamed_outcome.session.title, "Updated provider title");

        let conn = store.conn.lock().unwrap();
        let raw: String = conn
            .query_row(
                "SELECT payload_json FROM external_session_events
                 WHERE session_id = ?1 AND event_id = 'event-1'",
                params![first.session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&raw).unwrap(),
            snapshot.events[0].payload
        );
    }

    #[test]
    fn resync_keeps_continuation_after_new_external_messages() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("C:/work", "work").unwrap();
        let first = store
            .import_external_session(&workspace.id, &snapshot())
            .unwrap();
        store
            .append_message(&first.session.id, Role::User, "continue in miniQ")
            .unwrap();
        let continued_at = store.get_session(&first.session.id).unwrap().updated_at;

        let mut updated = snapshot();
        updated.summary.message_count = 3;
        updated.summary.updated_at = Some("2026-01-01T00:00:03Z".to_owned());
        updated.events.push(event(
            "event-3",
            2,
            json!({"role": "assistant", "content": "external follow-up"}),
        ));
        updated
            .messages
            .push(message("event-3", Role::Assistant, "external follow-up"));

        let synced = store
            .import_external_session(&workspace.id, &updated)
            .unwrap();
        assert_eq!(synced.imported_messages, 1);
        assert!(synced.session.updated_at >= continued_at);
        let contents: Vec<_> = store
            .list_messages(&first.session.id)
            .unwrap()
            .into_iter()
            .map(|message| message.content)
            .collect();
        assert_eq!(
            contents,
            [
                "full prompt",
                "full answer",
                "external follow-up",
                "continue in miniQ",
            ]
        );
    }

    fn snapshot() -> ExternalSessionSnapshot {
        ExternalSessionSnapshot {
            summary: ExternalSessionSummary {
                provider: ExternalProvider::Codex,
                external_id: "external-1".to_owned(),
                title: "Complete imported title".to_owned(),
                cwd: Some("C:/work".to_owned()),
                source_path: "C:/data/session.jsonl".to_owned(),
                message_count: 2,
                created_at: Some("2026-01-01T00:00:00Z".to_owned()),
                updated_at: Some("2026-01-01T00:00:02Z".to_owned()),
                continuation_mode: ExternalContinuationMode::RecreateOnly,
            },
            events: vec![
                event(
                    "event-1",
                    0,
                    json!({"nested": {"items": [1, 2, 3]}, "text": "complete"}),
                ),
                event(
                    "event-2",
                    1,
                    json!({"role": "assistant", "content": "answer"}),
                ),
            ],
            messages: vec![
                message("event-1", Role::User, "full prompt"),
                message("event-2", Role::Assistant, "full answer"),
            ],
        }
    }

    fn event(event_id: &str, sequence: usize, payload: serde_json::Value) -> ExternalSessionEvent {
        ExternalSessionEvent {
            event_id: event_id.to_owned(),
            sequence,
            event_type: "message".to_owned(),
            payload,
            occurred_at: Some(format!("2026-01-01T00:00:0{sequence}Z")),
        }
    }

    fn message(event_id: &str, role: Role, content: &str) -> ExternalSessionMessage {
        ExternalSessionMessage {
            event_id: event_id.to_owned(),
            role,
            content: content.to_owned(),
            occurred_at: Some("2026-01-01T00:00:00Z".to_owned()),
        }
    }
}
