use miniq_protocol::{
    ExecutionEventRecord, ExecutionEventsPage, ExecutionEventsParams, HistoryCursor,
};
use rusqlite::params;

use super::{MemoryError, Result, Store};

impl Store {
    pub fn execution_events_page(
        &self,
        input: &ExecutionEventsParams,
    ) -> Result<ExecutionEventsPage> {
        if !(1..=100).contains(&input.limit) {
            return Err(MemoryError::InvalidData(
                "limit must be between 1 and 100".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        // Expose only execution metadata, never the broader security audit log.
        let mut statement = conn.prepare(
            "SELECT id, created_at, event_type, payload_json FROM audit_events
             WHERE session_id = ?1
               AND event_type IN ('model_retry', 'context_compacted', 'queued_message_started', 'turn_outcome')
               AND (?2 IS NULL OR json_extract(payload_json, '$.agentId') = ?2)
               AND (?3 IS NULL OR (created_at, id) < (?3, ?4))
             ORDER BY created_at DESC, id DESC LIMIT ?5",
        )?;
        let rows = statement.query_map(
            params![
                input.session_id,
                input.agent_id,
                input.before.as_ref().map(|cursor| &cursor.at),
                input.before.as_ref().map(|cursor| &cursor.id),
                input.limit + 1,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?;
        let mut events = rows
            .map(|row| {
                let (id, created_at, event_type, raw) = row?;
                let data: serde_json::Value = serde_json::from_str(&raw)?;
                Ok(ExecutionEventRecord {
                    id,
                    session_id: input.session_id.clone(),
                    created_at,
                    event: serde_json::from_value(
                        serde_json::json!({"type": event_type, "data": data}),
                    )?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let next_cursor = if events.len() > input.limit as usize {
            events.pop();
            events.last().map(|event| HistoryCursor {
                at: event.created_at.clone(),
                id: event.id.clone(),
            })
        } else {
            None
        };
        Ok(ExecutionEventsPage {
            events,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pages_complete_events_without_crossing_session_agent_or_audit_scope() {
        let store = Store::open_in_memory().unwrap();
        for (session, agent, count) in [
            ("one", "child", 5),
            ("one", "sibling", 1),
            ("two", "child", 1),
        ] {
            for index in 0..count {
                store
                    .append_audit_event(
                        Some(session),
                        "context_compacted",
                        &json!({
                            "agentId": agent, "turnId": format!("turn-{index}"),
                            "estimatedTokensBefore": 10000, "estimatedTokensAfter": 2000,
                        }),
                    )
                    .unwrap();
            }
        }
        store
            .append_audit_event(Some("one"), "security_record", &json!({"agentId":"child"}))
            .unwrap();
        let mut input = ExecutionEventsParams {
            session_id: "one".into(),
            agent_id: Some("child".into()),
            before: None,
            limit: 2,
        };
        let mut ids = std::collections::HashSet::new();
        loop {
            let page = store.execution_events_page(&input).unwrap();
            assert!(page.events.len() <= 2);
            for event in page.events {
                assert!(ids.insert(event.id));
            }
            input.before = page.next_cursor;
            if input.before.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 5);
        input.agent_id = None;
        input.limit = 20;
        assert_eq!(store.execution_events_page(&input).unwrap().events.len(), 6);
        input.limit = 0;
        assert!(store.execution_events_page(&input).is_err());
    }
}
