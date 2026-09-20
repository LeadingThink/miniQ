use std::collections::HashMap;

use miniq_protocol::{Message, MessageTurnTiming, Role, TurnTiming, TurnTimingStatus};
use rusqlite::{params, Connection, OptionalExtension};

use super::{now_iso, MemoryError, Result, Store};

fn record_id(message_id: &str) -> String {
    format!("turn_timing_{message_id}")
}

impl Store {
    /// Independent of the history page: a long turn's user message can be
    /// earlier than the current page of tools shown by a remote client.
    pub fn latest_turn_timing(&self, session_id: &str) -> Result<Option<MessageTurnTiming>> {
        let row: Option<(String, String)> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT m.id, a.payload_json FROM messages m
             JOIN audit_events a ON a.id = 'turn_timing_' || m.id AND a.session_id = m.session_id
             WHERE m.id = (SELECT id FROM messages WHERE session_id = ?1 AND role = 'user'
                 ORDER BY created_at DESC, rowid DESC LIMIT 1) AND a.event_type = 'turn_timing'",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(message_id, raw)| {
            Ok(MessageTurnTiming {
                message_id,
                timing: serde_json::from_str(&raw)?,
            })
        })
        .transpose()
    }

    /// Called only after the session's execution slot is acquired. Queued
    /// requests have no timing until they are promoted to user messages.
    pub fn start_turn_timing(&self, session_id: &str) -> Result<(String, TurnTiming)> {
        let conn = self.conn.lock().unwrap();
        let message_id: String = conn.query_row(
            "SELECT id FROM messages WHERE session_id = ?1 AND role = 'user'
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [session_id],
            |row| row.get(0),
        )?;
        let timing = TurnTiming {
            started_at: now_iso(),
            completed_at: None,
            elapsed_ms: None,
            status: TurnTimingStatus::Running,
        };
        conn.execute(
            "INSERT INTO audit_events (id, session_id, event_type, payload_json, created_at)
             VALUES (?1, ?2, 'turn_timing', ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json,
                 created_at = excluded.created_at WHERE audit_events.session_id = excluded.session_id",
            params![record_id(&message_id), session_id, serde_json::to_string(&timing)?, timing.started_at],
        )?;
        Ok((message_id, timing))
    }

    pub fn finish_turn_timing(
        &self,
        session_id: &str,
        message_id: &str,
        timing: &TurnTiming,
    ) -> Result<()> {
        let updated = self.conn.lock().unwrap().execute(
            "UPDATE audit_events SET payload_json = ?3
             WHERE id = ?1 AND session_id = ?2 AND event_type = 'turn_timing'
               AND json_extract(payload_json, '$.status') = 'running'",
            params![
                record_id(message_id),
                session_id,
                serde_json::to_string(timing)?
            ],
        )?;
        if updated != 1 {
            return Err(MemoryError::NotFound(format!(
                "active turn timing {message_id}"
            )));
        }
        Ok(())
    }
}

/// Attach only the requested page's records, using audit primary keys rather
/// than scanning or transmitting timing for an entire conversation.
pub(super) fn attach(conn: &Connection, messages: &mut [Message]) -> Result<()> {
    let ids = messages
        .iter()
        .filter(|message| message.role == Role::User)
        .map(|message| record_id(&message.id))
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(());
    }
    let mut statement = conn.prepare(
        "SELECT id, payload_json FROM audit_events
         WHERE id IN (SELECT value FROM json_each(?1)) AND event_type = 'turn_timing'",
    )?;
    let rows = statement.query_map([serde_json::to_string(&ids)?], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut timings = HashMap::new();
    for row in rows {
        let (id, raw) = row?;
        timings.insert(id, serde_json::from_str::<TurnTiming>(&raw)?);
    }
    for message in messages {
        message.turn_timing = timings.remove(&record_id(&message.id));
    }
    Ok(())
}

/// A new process cannot know when the old process stopped. Do not turn the
/// offline interval into execution time or invent a completion timestamp.
pub(super) fn interrupt(conn: &Connection, session_id: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE audit_events SET payload_json = json_set(payload_json, '$.status', 'interrupted')
         WHERE event_type = 'turn_timing' AND (?1 IS NULL OR session_id = ?1)
           AND json_extract(payload_json, '$.status') = 'running'",
        [session_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
