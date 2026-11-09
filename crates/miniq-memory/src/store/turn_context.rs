use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{now_iso, Result, Store};

/// Compact record of the model-visible context sections for one session.
///
/// Only fingerprints are stored: the section bodies live in the files they come
/// from, so this never duplicates project instructions on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnContextSnapshot {
    pub session_id: String,
    pub sections: Value,
    pub updated_at: String,
}

impl Store {
    pub fn get_turn_context(&self, session_id: &str) -> Result<Option<TurnContextSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT session_id, sections_json, updated_at
                 FROM turn_context_snapshots WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.and_then(|(session_id, json, updated_at)| {
            // A corrupt row must not break a turn; treat it as "no history".
            let sections = serde_json::from_str::<Value>(&json).ok()?;
            Some(TurnContextSnapshot {
                session_id,
                sections,
                updated_at,
            })
        }))
    }

    pub fn save_turn_context(&self, session_id: &str, sections: &Value) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO turn_context_snapshots (session_id, sections_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET
                 sections_json = excluded.sections_json,
                 updated_at = excluded.updated_at",
            params![session_id, sections.to_string(), now_iso()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_survives_a_corrupt_row() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/workspace", "ws").unwrap();
        let session = store.create_session(&workspace.id, "title").unwrap();
        assert!(store.get_turn_context(&session.id).unwrap().is_none());

        let sections = serde_json::json!([{ "id": "project_instructions", "hash": "abc" }]);
        store.save_turn_context(&session.id, &sections).unwrap();
        let loaded = store.get_turn_context(&session.id).unwrap().unwrap();
        assert_eq!(loaded.sections, sections);

        store
            .save_turn_context(&session.id, &serde_json::json!([{ "id": "runtime" }]))
            .unwrap();
        assert_eq!(
            store
                .get_turn_context(&session.id)
                .unwrap()
                .unwrap()
                .sections,
            serde_json::json!([{ "id": "runtime" }])
        );

        // Corrupt JSON is treated as absent instead of failing the turn.
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE turn_context_snapshots SET sections_json = 'not json' WHERE session_id = ?1",
                params![session.id],
            )
            .unwrap();
        }
        assert!(store.get_turn_context(&session.id).unwrap().is_none());
    }
}
