use miniq_protocol::{
    AgentHistoryCursor, AgentHistoryEntry, AgentHistoryMessage, AgentHistoryPage,
    AgentHistoryParams, AgentMessageParams,
};
use rusqlite::{params, Connection, OptionalExtension};

use super::{MemoryError, Result, Store};

fn revision(
    conn: &Connection,
    session_id: &str,
    agent_id: &str,
    expected: Option<u64>,
) -> Result<u64> {
    let current: u64 = conn
        .query_row(
            "SELECT history_revision FROM agent_tasks WHERE session_id = ?1 AND id = ?2",
            params![session_id, agent_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("agent: {agent_id}")))?;
    if expected.is_some_and(|expected| expected != current) {
        return Err(MemoryError::InvalidData(
            "agent history changed; refresh from the latest checkpoint".into(),
        ));
    }
    Ok(current)
}

impl Store {
    pub fn agent_history_page(&self, input: &AgentHistoryParams) -> Result<AgentHistoryPage> {
        if !(1..=100).contains(&input.limit) {
            return Err(MemoryError::InvalidData(
                "limit must be between 1 and 100".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let revision = revision(
            &conn,
            &input.session_id,
            &input.agent_id,
            input.cursor.as_ref().map(|cursor| cursor.revision),
        )?;
        // Read only metadata from the JSON checkpoint. Full text/native context
        // is fetched on expansion, never shipped with a history list.
        let mut statement = conn.prepare(
            "SELECT CAST(item.key AS INTEGER), json_extract(item.value, '$.role'),
             COALESCE(length(json_extract(item.value, '$.content')), 0),
             COALESCE(json_array_length(item.value, '$.tool_calls'), 0),
             COALESCE(json_array_length(item.value, '$.images'), 0)
             FROM agent_tasks, json_each(agent_tasks.history_json) AS item
             WHERE session_id = ?1 AND agent_tasks.id = ?2
               AND (?3 IS NULL OR CAST(item.key AS INTEGER) < ?3)
             ORDER BY CAST(item.key AS INTEGER) DESC LIMIT ?4",
        )?;
        let mut entries = statement
            .query_map(
                params![
                    input.session_id,
                    input.agent_id,
                    input.cursor.as_ref().map(|cursor| cursor.before),
                    input.limit + 1
                ],
                |row| {
                    Ok(AgentHistoryEntry {
                        index: row.get(0)?,
                        role: row.get(1)?,
                        text_characters: row.get(2)?,
                        tool_count: row.get(3)?,
                        image_count: row.get(4)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let next_cursor = if entries.len() > input.limit as usize {
            entries.pop();
            entries.last().map(|entry| AgentHistoryCursor {
                revision,
                before: entry.index,
            })
        } else {
            None
        };
        Ok(AgentHistoryPage {
            revision,
            entries,
            next_cursor,
        })
    }

    pub fn agent_history_message(&self, input: &AgentMessageParams) -> Result<AgentHistoryMessage> {
        let conn = self.conn.lock().unwrap();
        revision(
            &conn,
            &input.session_id,
            &input.agent_id,
            Some(input.revision),
        )?;
        let raw: Option<String> = conn.query_row(
            "SELECT json_extract(history_json, ?3) FROM agent_tasks WHERE session_id = ?1 AND id = ?2",
            params![input.session_id, input.agent_id, format!("$[{}]", input.index)], |row| row.get(0),
        )?;
        let message = serde_json::from_str(
            &raw.ok_or_else(|| MemoryError::NotFound("agent history entry".into()))?,
        )?;
        Ok(AgentHistoryMessage { message })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pages_metadata_and_loads_complete_messages_with_revision_and_ownership_checks() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace("/tmp/agent-history", "history")
            .unwrap();
        let session = store.create_session(&workspace.id, "history").unwrap();
        store
            .create_agent_task(&crate::AgentTaskRow {
                id: "agent".into(),
                session_id: session.id.clone(),
                name: "test".into(),
                parent_id: None,
                created_at: "2026-09-09".into(),
                state: json!({}),
            })
            .unwrap();
        let history = json!([
            {"role":"system", "content":"instructions"},
            {"role":"user", "content":"inspect", "images":[{"path":"/tmp/image.png"}]},
            {"role":"assistant", "content":"", "tool_calls":[{"id":"tool"}]},
            {"role":"tool", "content":"evidence".repeat(200000)},
        ]);
        store
            .save_agent_task(&session.id, "agent", &json!({}), Some(&history), None)
            .unwrap();
        let mut input = AgentHistoryParams {
            session_id: session.id.clone(),
            agent_id: "agent".into(),
            cursor: None,
            limit: 2,
        };
        let page = store.agent_history_page(&input).unwrap();
        assert_eq!(page.entries[0].text_characters, 1_600_000);
        assert_eq!(page.entries[1].tool_count, 1);
        assert!(serde_json::to_vec(&page).unwrap().len() < 1024);
        input.cursor = page.next_cursor;
        let older = store.agent_history_page(&input).unwrap();
        assert_eq!(older.entries[0].index, 1);
        assert_eq!(older.entries[0].image_count, 1);
        assert!(older.next_cursor.is_none());
        let mut detail = AgentMessageParams {
            session_id: session.id.clone(),
            agent_id: "agent".into(),
            revision: page.revision,
            index: 3,
        };
        assert_eq!(
            store.agent_history_message(&detail).unwrap().message,
            history[3]
        );
        detail.session_id = "other".into();
        assert!(store.agent_history_message(&detail).is_err());
        detail.session_id = session.id.clone();
        store
            .save_agent_task(&session.id, "agent", &json!({}), Some(&json!([])), None)
            .unwrap();
        assert!(store.agent_history_page(&input).is_err());
        assert!(store.agent_history_message(&detail).is_err());
    }
}
