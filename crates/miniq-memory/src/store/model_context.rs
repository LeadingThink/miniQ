use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{now_iso, Result, Store};

#[derive(Debug, Clone)]
pub struct ModelContextSnapshot {
    pub model_identity: Option<String>,
    pub last_message_id: String,
    pub history: Value,
}

impl Store {
    pub fn get_model_context(&self, session_id: &str) -> Result<Option<ModelContextSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT last_message_id, history_json, model_identity
                 FROM model_context_snapshots WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(last_message_id, history_json, model_identity)| {
            Ok(ModelContextSnapshot {
                model_identity,
                last_message_id,
                history: serde_json::from_str(&history_json)?,
            })
        })
        .transpose()
    }

    pub fn save_model_context(
        &self,
        session_id: &str,
        last_message_id: &str,
        history: &Value,
        model_identity: Option<&str>,
    ) -> Result<()> {
        self.save_context_with_message(session_id, last_message_id, history, model_identity, None)
    }

    pub fn save_context_with_message(
        &self,
        session_id: &str,
        last_message_id: &str,
        history: &Value,
        model_identity: Option<&str>,
        message: Option<&miniq_protocol::Message>,
    ) -> Result<()> {
        if message.is_some_and(|message| {
            message.session_id != session_id || message.id != last_message_id
        }) {
            return Err(super::MemoryError::InvalidData(
                "checkpoint message does not match its session and anchor".into(),
            ));
        }
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        if let Some(message) = message {
            super::conversation::insert_message(&transaction, message)?;
        }
        transaction.execute(
            "INSERT INTO model_context_snapshots
               (session_id, last_message_id, history_json, updated_at, model_identity)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id) DO UPDATE SET
               last_message_id = excluded.last_message_id,
               history_json = excluded.history_json,
               updated_at = excluded.updated_at,
               model_identity = excluded.model_identity",
            params![
                session_id,
                last_message_id,
                serde_json::to_string(history)?,
                now_iso(),
                model_identity
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::Role;
    use serde_json::json;

    #[test]
    fn partial_message_and_snapshot_are_atomic_durable_and_session_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("context.db");
        let store = Store::open(&database).unwrap();
        let workspace = store.create_workspace("/work", "project").unwrap();
        let session = store.create_session(&workspace.id, "first").unwrap();
        let other = store.create_session(&workspace.id, "second").unwrap();
        let input = store
            .append_message(&session.id, Role::User, "task")
            .unwrap();
        store
            .save_model_context(&session.id, &input.id, &json!([]), None)
            .unwrap();
        let mut partial = miniq_protocol::Message {
            id: "partial".into(),
            session_id: other.id.clone(),
            role: Role::Assistant,
            content: "interrupted output".into(),
            attachments: Vec::new(),
            created_at: now_iso(),
        };
        assert!(store
            .save_context_with_message(
                &session.id,
                &partial.id,
                &json!(["partial"]),
                None,
                Some(&partial)
            )
            .is_err());
        partial.session_id = session.id.clone();
        store
            .save_context_with_message(
                &session.id,
                &partial.id,
                &json!(["partial"]),
                Some("model"),
                Some(&partial),
            )
            .unwrap();
        // A duplicate message insertion must not update the snapshot.
        assert!(store
            .save_context_with_message(
                &session.id,
                &partial.id,
                &json!(["wrong"]),
                None,
                Some(&partial)
            )
            .is_err());
        drop(store);
        let store = Store::open(&database).unwrap();
        let snapshot = store.get_model_context(&session.id).unwrap().unwrap();
        assert_eq!(snapshot.history, json!(["partial"]));
        assert_eq!(snapshot.last_message_id, partial.id);
        assert_eq!(store.list_messages(&session.id).unwrap().len(), 2);
        assert!(store.list_messages(&other.id).unwrap().is_empty());
        assert!(store.get_model_context(&other.id).unwrap().is_none());
    }

    #[test]
    fn model_context_round_trips_and_replaces_atomically() {
        let store = Store::open_in_memory().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let workspace = store
            .create_workspace(directory.path().to_str().unwrap(), "context")
            .unwrap();
        let session = store.create_session(&workspace.id, "context").unwrap();
        let first = store
            .append_message(&session.id, Role::User, "first")
            .unwrap();
        store
            .save_model_context(
                &session.id,
                &first.id,
                &json!([{"role": "user"}]),
                Some("model-a"),
            )
            .unwrap();

        let second = store
            .append_message(&session.id, Role::Assistant, "second")
            .unwrap();
        store
            .save_model_context(
                &session.id,
                &second.id,
                &json!([{"role": "user"}, {"role": "assistant"}]),
                Some("model-b"),
            )
            .unwrap();

        let snapshot = store.get_model_context(&session.id).unwrap().unwrap();
        assert_eq!(snapshot.last_message_id, second.id);
        assert_eq!(snapshot.model_identity.as_deref(), Some("model-b"));
        assert_eq!(snapshot.history.as_array().unwrap().len(), 2);
    }
}
