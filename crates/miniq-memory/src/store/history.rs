use miniq_protocol::{HistoryCursor, HistoryPage, HistoryParams, HistoryToolCall};
use rusqlite::params;

use super::row_mappers::{row_to_message, row_to_tool_call};
use super::{MemoryError, Result, Store};

impl Store {
    /// Select positions first so unopened tool bodies never cross the SQLite boundary.
    pub fn history_page(&self, input: &HistoryParams) -> Result<HistoryPage> {
        if !(1..=100).contains(&input.limit) {
            return Err(MemoryError::InvalidData("invalid history page size".into()));
        }
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "WITH timeline AS (
                SELECT id, created_at, 'message' AS kind FROM messages
                WHERE session_id = ?1 AND (?5 OR role != 'system')
                  AND (?6 = 'all' OR (?6 = 'answers' AND role IN ('user', 'assistant'))
                       OR (?6 = 'activity' AND role = 'tool'))
                  AND (?7 = '' OR instr(lower(content), lower(?7)) > 0)
                UNION ALL
                SELECT id, created_at, 'tool' AS kind FROM tool_calls
                WHERE session_id = ?1 AND (?5 OR tool_name != 'task_update')
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
        };
        for (id, _, kind) in positions.into_iter().rev() {
            if kind == "message" {
                page.messages.push(conn.query_row(
                    "SELECT id, session_id, role, content, attachments_json, created_at FROM messages WHERE id = ?1 AND session_id = ?2",
                    params![id, input.session_id], row_to_message,
                )?);
            } else {
                let query = if input.include_payloads {
                    "SELECT id, session_id, tool_name, input_json, output_json, status, created_at, completed_at FROM tool_calls WHERE id = ?1 AND session_id = ?2"
                } else {
                    "SELECT id, session_id, tool_name, 'null', NULL, status, created_at, completed_at FROM tool_calls WHERE id = ?1 AND session_id = ?2"
                };
                page.tool_calls.push(HistoryToolCall {
                    call: conn.query_row(query, params![id, input.session_id], row_to_tool_call)?,
                    payload_deferred: !input.include_payloads,
                });
            }
        }
        Ok(page)
    }
}

#[cfg(test)]
mod tests;
