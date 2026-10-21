use miniq_protocol::Artifact;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{new_id, now_iso, Result, Store};

impl Store {
    pub fn create_artifact(
        &self,
        session_id: &str,
        path: &str,
        kind: &str,
        title: &str,
    ) -> Result<Artifact> {
        let conn = self.conn.lock().unwrap();
        let artifact = Artifact {
            id: new_id("art"),
            session_id: session_id.to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO artifacts (id, session_id, path, kind, title, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                artifact.id,
                artifact.session_id,
                artifact.path,
                artifact.kind,
                artifact.title,
                artifact.created_at
            ],
        )?;
        Ok(artifact)
    }

    pub fn list_artifacts(&self, session_id: &str) -> Result<Vec<Artifact>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, path, kind, title, created_at
             FROM artifacts WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Artifact {
                id: row.get(0)?,
                session_id: row.get(1)?,
                path: row.get(2)?,
                kind: row.get(3)?,
                title: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn append_audit_event(
        &self,
        session_id: Option<&str>,
        event_type: &str,
        payload: &Value,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO audit_events (id, session_id, event_type, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                new_id("audit"),
                session_id,
                event_type,
                serde_json::to_string(payload)?,
                now_iso()
            ],
        )?;
        Ok(())
    }

    pub fn count_audit_events(&self, session_id: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let count = conn.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Record before admitting the next turn. Clearing a failure badge must
    /// never change the durable outcome used by reconnecting clients.
    pub fn record_turn_outcome(
        &self,
        session_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        let anchor: String = self.conn.lock().unwrap().query_row(
            "SELECT id FROM messages WHERE session_id = ?1 AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [session_id], |row| row.get(0))?;
        let mut outcome = serde_json::json!({"anchorMessageId":anchor,"status":status});
        if let Some(error) = error {
            outcome["error"] = serde_json::Value::String(error.to_string());
        }
        self.append_audit_event(Some(session_id), "turn_outcome", &outcome)
    }

    pub fn last_turn_outcome(&self, session_id: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self.conn.lock().unwrap().query_row(
            "SELECT payload_json FROM audit_events WHERE session_id = ?1 AND event_type = 'turn_outcome'
             AND json_extract(payload_json, '$.anchorMessageId') =
                (SELECT id FROM messages WHERE session_id = ?1 AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1)
             ORDER BY rowid DESC LIMIT 1", [session_id], |row| row.get(0)).optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }
}

/// Capture an interrupted process's reason before recovery clears active status.
/// Sessions with no user request have no turn to attach an outcome to.
pub(super) fn record_interrupted_turn_outcomes(
    conn: &Connection,
    session_id: Option<&str>,
    error: &str,
) -> Result<()> {
    conn.execute(
        "WITH active AS (
             SELECT s.id AS session_id, (SELECT id FROM messages WHERE session_id = s.id
                 AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1) AS anchor
             FROM sessions s WHERE status IN ('running', 'waiting_approval', 'cancelling')
                 AND (?1 IS NULL OR s.id = ?1)
         ) INSERT INTO audit_events (id, session_id, event_type, payload_json, created_at)
         SELECT 'audit_' || lower(hex(randomblob(16))), session_id, 'turn_outcome',
             json_object('anchorMessageId', anchor, 'status', 'failed', 'error', ?2), ?3
         FROM active WHERE anchor IS NOT NULL AND NOT coalesce((
             SELECT json_extract(payload_json, '$.status') IN ('completed', 'failed', 'cancelled')
             FROM audit_events WHERE session_id = active.session_id AND event_type = 'turn_outcome'
                 AND json_extract(payload_json, '$.anchorMessageId') = active.anchor
             ORDER BY rowid DESC LIMIT 1), 0)",
        params![session_id, error, now_iso()],
    )?;
    Ok(())
}

#[cfg(test)]
mod turn_outcome_tests {
    use super::*;
    use miniq_protocol::{Role, SessionStatus};

    #[test]
    fn badges_and_partial_answers_cannot_turn_failure_into_success() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/fixture", "fixture").unwrap();
        let session = store.create_session(&workspace.id, "fixture").unwrap();
        assert!(store.last_turn_outcome(&session.id).unwrap().is_none());
        store
            .append_message(&session.id, Role::User, "first")
            .unwrap();
        store
            .append_message(&session.id, Role::Assistant, "partial")
            .unwrap();
        store
            .record_turn_outcome(&session.id, "failed", Some("provider timed out"))
            .unwrap();
        store
            .update_session_status(&session.id, SessionStatus::Idle)
            .unwrap();
        assert_eq!(
            store.last_turn_outcome(&session.id).unwrap().unwrap()["status"],
            "failed"
        );
        assert_eq!(
            store.last_turn_outcome(&session.id).unwrap().unwrap()["error"],
            "provider timed out"
        );
        store
            .append_message(&session.id, Role::User, "second")
            .unwrap();
        assert!(store.last_turn_outcome(&session.id).unwrap().is_none());
        store
            .record_turn_outcome(&session.id, "completed", None)
            .unwrap();
        assert_eq!(
            store.last_turn_outcome(&session.id).unwrap().unwrap()["status"],
            "completed"
        );
        assert!(store.last_turn_outcome(&session.id).unwrap().unwrap()["error"].is_null());
    }

    #[test]
    fn failure_reason_survives_reopening_and_remains_session_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let store = Store::open(&path).unwrap();
        let workspace = store.create_workspace("/fixture", "fixture").unwrap();
        let session = store.create_session(&workspace.id, "failed").unwrap();
        let other = store.create_session(&workspace.id, "other").unwrap();
        let user = store
            .append_message(&session.id, Role::User, "task")
            .unwrap();
        let reason = "provider error: invalid response: Anthropic Messages API error: The request timed out while trying to download the file. Please try again later. (request id: fixture)";
        store
            .record_turn_outcome(&session.id, "failed", Some(reason))
            .unwrap();
        drop(store);

        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.last_turn_outcome(&session.id).unwrap().unwrap(),
            serde_json::json!({"anchorMessageId":user.id,"status":"failed","error":reason})
        );
        assert!(reopened.last_turn_outcome(&other.id).unwrap().is_none());
        let events = reopened
            .execution_events_page(
                &serde_json::from_value(serde_json::json!({"sessionId":session.id})).unwrap(),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(events).unwrap()["events"][0]["data"]["error"],
            reason
        );
    }
}
