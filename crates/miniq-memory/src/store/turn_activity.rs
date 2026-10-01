use rusqlite::params;

use super::{Result, Store};

/// Tool and file activity recorded for a session since a turn started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnActivity {
    pub tool_calls: u32,
    pub failed_tool_calls: u32,
    pub files_changed: u32,
}

impl Store {
    /// Counts tool calls (all agents) and distinct checkpointed file paths
    /// created at or after `since` (RFC 3339). `julianday` compares instants,
    /// so differing fractional-second precision cannot misorder timestamps.
    pub fn turn_activity(&self, session_id: &str, since: &str) -> Result<TurnActivity> {
        let conn = self.conn.lock().unwrap();
        let (tool_calls, failed_tool_calls, files_changed): (i64, i64, i64) = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM tool_calls
                  WHERE session_id = ?1 AND julianday(created_at) >= julianday(?2)),
                (SELECT COUNT(*) FROM tool_calls
                  WHERE session_id = ?1 AND julianday(created_at) >= julianday(?2)
                    AND status = 'failed'),
                (SELECT COUNT(DISTINCT abs_path) FROM checkpoints
                  WHERE session_id = ?1 AND julianday(created_at) >= julianday(?2))",
            params![session_id, since],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let count = |value: i64| u32::try_from(value).unwrap_or(u32::MAX);
        Ok(TurnActivity {
            tool_calls: count(tool_calls),
            failed_tool_calls: count(failed_tool_calls),
            files_changed: count(files_changed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::ToolCallStatus;
    use serde_json::json;

    #[test]
    fn turn_activity_counts_only_calls_and_files_since_turn_start() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/turn-activity", "ws").unwrap();
        let session = store.create_session(&workspace.id, "s").unwrap();
        let old = store
            .create_tool_call(
                &session.id,
                "read",
                &json!({}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        store
            .create_checkpoint(&session.id, &old.id, "/tmp/old.txt", true, None)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let since = super::super::now_iso();
        let ok = store
            .create_tool_call(
                &session.id,
                "write",
                &json!({}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        let bad = store
            .create_tool_call(
                &session.id,
                "shell",
                &json!({}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        store
            .update_tool_call_status(&bad.id, ToolCallStatus::Failed)
            .unwrap();
        for path in ["/tmp/a.txt", "/tmp/a.txt", "/tmp/b.txt"] {
            store
                .create_checkpoint(&session.id, &ok.id, path, false, None)
                .unwrap();
        }
        let activity = store.turn_activity(&session.id, &since).unwrap();
        assert_eq!(
            activity,
            TurnActivity {
                tool_calls: 2,
                failed_tool_calls: 1,
                files_changed: 2,
            }
        );
    }
}
