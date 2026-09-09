use miniq_protocol::{HistoryCursor, ModelCallRecord, ModelCallsPage, ModelCallsParams};
use rusqlite::params;

use super::{MemoryError, Result, Store};

impl Store {
    pub fn save_model_call(&self, record: &ModelCallRecord) -> Result<()> {
        let raw = serde_json::to_string(record)?;
        let status = serde_json::to_value(record.status)?;
        let changed = self.conn.lock().unwrap().execute(
            "INSERT INTO model_calls (id, session_id, agent_id, started_at, status, record_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json
             WHERE model_calls.session_id = excluded.session_id AND model_calls.agent_id IS excluded.agent_id",
            params![record.id, record.session_id, record.agent_id, record.started_at, status.as_str(), raw],
        )?;
        if changed == 0 {
            return Err(MemoryError::InvalidData(
                "model call belongs to a different session or agent".into(),
            ));
        }
        Ok(())
    }

    pub fn model_calls_page(&self, input: &ModelCallsParams) -> Result<ModelCallsPage> {
        if !(1..=100).contains(&input.limit) {
            return Err(MemoryError::InvalidData(
                "limit must be between 1 and 100".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT record_json FROM model_calls
             WHERE session_id = ?1 AND (?2 IS NULL OR agent_id = ?2)
               AND (?3 IS NULL OR (started_at, id) < (?3, ?4))
             ORDER BY started_at DESC, id DESC LIMIT ?5",
        )?;
        let raw = statement.query_map(
            params![
                input.session_id,
                input.agent_id,
                input.before.as_ref().map(|cursor| &cursor.at),
                input.before.as_ref().map(|cursor| &cursor.id),
                input.limit + 1,
            ],
            |row| row.get::<_, String>(0),
        )?;
        let mut calls = raw
            .map(|row| Ok(serde_json::from_str::<ModelCallRecord>(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        let next_cursor = if calls.len() > input.limit as usize {
            calls.pop();
            calls.last().map(|call| HistoryCursor {
                at: call.started_at.clone(),
                id: call.id.clone(),
            })
        } else {
            None
        };
        Ok(ModelCallsPage { calls, next_cursor })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::ModelCallStatus;
    use serde_json::json;

    fn session(store: &Store, title: &str) -> String {
        let workspace = store
            .create_workspace(&format!("/tmp/model-calls-{title}"), title)
            .unwrap();
        store.create_session(&workspace.id, title).unwrap().id
    }

    fn record(id: &str, session_id: &str) -> ModelCallRecord {
        serde_json::from_value(json!({
            "id": id, "sessionId": session_id, "agentId": "child", "turnId": "turn",
            "trace": {"purpose":"task", "step":1, "attempt":1},
            "startedAt":"2026-09-09T00:00:00Z", "status":"running",
            "estimatedInputTokens":12,
            "response": {"usage":{"input_tokens":10}}
        }))
        .unwrap()
    }

    #[test]
    fn rejects_owner_changes_and_preserves_the_original_record() {
        let store = Store::open_in_memory().unwrap();
        let one = session(&store, "one");
        let two = session(&store, "two");
        let original = record("request", &one);
        store.save_model_call(&original).unwrap();
        let mut conflicting = original.clone();
        conflicting.session_id = two;
        assert!(store.save_model_call(&conflicting).is_err());
        conflicting.session_id = one.clone();
        conflicting.agent_id = None;
        assert!(store.save_model_call(&conflicting).is_err());
        let params: ModelCallsParams = serde_json::from_value(json!({"sessionId":one})).unwrap();
        let page = store.model_calls_page(&params).unwrap();
        assert_eq!(page.calls.len(), 1);
        assert_eq!(page.calls[0].agent_id, original.agent_id);
        conflicting.agent_id = original.agent_id;
        conflicting.status = ModelCallStatus::Completed;
        store.save_model_call(&conflicting).unwrap();
        assert_eq!(
            store.model_calls_page(&params).unwrap().calls[0].status,
            ModelCallStatus::Completed
        );
    }

    #[test]
    fn cursor_pages_equal_timestamps_without_losing_calls_or_crossing_sessions() {
        let store = Store::open_in_memory().unwrap();
        let one = session(&store, "one");
        let two = session(&store, "two");
        for id in ["a", "b", "c"] {
            store.save_model_call(&record(id, &one)).unwrap();
        }
        let other = record("other", &two);
        store.save_model_call(&other).unwrap();
        let mut params: ModelCallsParams =
            serde_json::from_value(json!({"sessionId":one, "limit":2})).unwrap();
        let first = store.model_calls_page(&params).unwrap();
        assert_eq!(
            first
                .calls
                .iter()
                .map(|call| call.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "b"]
        );
        params.before = first.next_cursor;
        let second = store.model_calls_page(&params).unwrap();
        assert_eq!(second.calls[0].id, "a");
        assert!(second.next_cursor.is_none());
        params.before = None;
        params.agent_id = Some("absent-child".into());
        assert!(store.model_calls_page(&params).unwrap().calls.is_empty());
    }
}
