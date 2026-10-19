use miniq_protocol::{
    HistoryCursor, HistoryPage, HistoryParams, HistoryToolCall, HistoryView, ProcessRecordsParams,
};
use rusqlite::{params, params_from_iter};
use std::collections::HashMap;

use super::row_mappers::{row_to_message, row_to_tool_call};
use super::{MemoryError, Result, Store};

impl Store {
    /// Select positions first so unopened tool bodies never cross the SQLite boundary.
    pub fn history_page(&self, input: &HistoryParams) -> Result<HistoryPage> {
        if !(1..=100).contains(&input.limit) {
            return Err(MemoryError::InvalidData("invalid history page size".into()));
        }
        let conn = self.conn.lock().unwrap();
        if input.view == HistoryView::Visible {
            return super::history_visible::visible_page(&conn, input);
        }
        let mut statement = conn.prepare(
            "WITH timeline AS (
                SELECT id, created_at, 'message' AS kind FROM messages
                WHERE session_id = ?1 AND ?8 IS NULL AND ?9 IS NULL AND (?5 OR role != 'system')
                  AND (?6 = 'all' OR (?6 = 'answers' AND role IN ('user', 'assistant'))
                       OR (?6 = 'activity' AND role = 'tool'))
                  AND (?7 = '' OR instr(lower(content), lower(?7)) > 0)
                UNION ALL
                SELECT id, created_at, 'tool' AS kind FROM tool_calls
                WHERE session_id = ?1 AND (?8 IS NULL OR agent_id = ?8) AND (?9 IS NULL OR tool_name = ?9)
                  AND (?5 OR tool_name != 'task_update')
                  AND (?6 IN ('all', 'activity') OR (?6 = 'errors' AND status IN ('failed', 'rejected', 'cancelled')))
                  AND (?7 = '' OR instr(lower(tool_name || char(10) || input_json || char(10) || coalesce(output_json, '')), lower(?7)) > 0)
             ) SELECT id, created_at, kind FROM timeline
             WHERE ?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)
             ORDER BY created_at DESC, id DESC LIMIT ?4",
        )?;
        let positions = statement.query_map(
            params![
                input.session_id,
                input.before.as_ref().map(|cursor| &cursor.at),
                input.before.as_ref().map(|cursor| &cursor.id),
                input.limit + 1,
                input.include_internal,
                input.filter.as_str(),
                input.query.trim(),
                input.agent_id,
                input.tool_name,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        let mut positions = positions.collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = positions.len() > input.limit as usize;
        if has_more {
            positions.pop();
        }
        let next_cursor = if has_more {
            positions.last().map(|(id, at, _)| HistoryCursor {
                at: at.clone(),
                id: id.clone(),
            })
        } else {
            None
        };
        let mut page = HistoryPage {
            messages: Vec::new(),
            tool_calls: Vec::new(),
            next_cursor,
            process_summaries: Vec::new(),
        };
        // Fetch details in two bounded queries instead of one query per
        // timeline position. Remote session.open commonly requests 40 rows;
        // the old path could issue up to 40 extra SQLite queries before the
        // response was serialized and sent through the relay.
        let message_ids = positions
            .iter()
            .filter(|(_, _, kind)| kind == "message")
            .map(|(id, _, _)| id.clone())
            .collect::<Vec<_>>();
        let tool_ids = positions
            .iter()
            .filter(|(_, _, kind)| kind == "tool")
            .map(|(id, _, _)| id.clone())
            .collect::<Vec<_>>();
        let messages = load_messages(&conn, &input.session_id, &message_ids)?;
        let tools = load_tools(&conn, &input.session_id, &tool_ids, input.include_payloads)?;
        for (id, _, kind) in positions.into_iter().rev() {
            if kind == "message" {
                if let Some(message) = messages.get(&id) {
                    page.messages.push(message.clone());
                }
            } else if let Some(tool) = tools.get(&id) {
                page.tool_calls.push(tool.clone());
            }
        }
        super::turn_timing::attach(&conn, &mut page.messages)?;
        Ok(page)
    }

    /// The folded records of one turn, a bounded page at a time.
    pub fn process_records_page(&self, input: &ProcessRecordsParams) -> Result<HistoryPage> {
        if !(1..=100).contains(&input.limit) {
            return Err(MemoryError::InvalidData("invalid history page size".into()));
        }
        let conn = self.conn.lock().unwrap();
        super::history_visible::process_records_page(&conn, input)
    }
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

pub(super) fn load_messages(
    conn: &rusqlite::Connection,
    session_id: &str,
    ids: &[String],
) -> Result<HashMap<String, miniq_protocol::Message>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let query = format!(
        "SELECT id, session_id, role, content, attachments_json, created_at, steered, assistant_kind FROM messages WHERE session_id = ? AND id IN ({})",
        placeholders(ids.len())
    );
    let mut values = Vec::<&dyn rusqlite::ToSql>::with_capacity(ids.len() + 1);
    values.push(&session_id);
    values.extend(ids.iter().map(|id| id as &dyn rusqlite::ToSql));
    let mut statement = conn.prepare(&query).map_err(MemoryError::from)?;
    let rows = statement
        .query_map(params_from_iter(values), row_to_message)
        .map_err(MemoryError::from)?;
    let mut output = HashMap::with_capacity(ids.len());
    for row in rows {
        let message = row.map_err(MemoryError::from)?;
        output.insert(message.id.clone(), message);
    }
    Ok(output)
}

pub(super) fn load_tools(
    conn: &rusqlite::Connection,
    session_id: &str,
    ids: &[String],
    include_payloads: bool,
) -> Result<HashMap<String, HistoryToolCall>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let payload_input = if include_payloads {
        "input_json"
    } else {
        "'null'"
    };
    let payload_output = if include_payloads {
        "output_json"
    } else {
        "NULL"
    };
    let query = format!(
        "SELECT id, session_id, tool_name, {payload_input}, {payload_output}, status, created_at, completed_at, agent_id FROM tool_calls WHERE session_id = ? AND id IN ({})",
        placeholders(ids.len())
    );
    let mut values = Vec::<&dyn rusqlite::ToSql>::with_capacity(ids.len() + 1);
    values.push(&session_id);
    values.extend(ids.iter().map(|id| id as &dyn rusqlite::ToSql));
    let mut statement = conn.prepare(&query).map_err(MemoryError::from)?;
    let rows = statement
        .query_map(params_from_iter(values), row_to_tool_call)
        .map_err(MemoryError::from)?;
    let mut output = HashMap::with_capacity(ids.len());
    for row in rows {
        let call = row.map_err(MemoryError::from)?;
        output.insert(
            call.id.clone(),
            HistoryToolCall {
                call,
                payload_deferred: !include_payloads,
            },
        );
    }
    Ok(output)
}

#[cfg(test)]
mod tests;
