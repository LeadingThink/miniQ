use miniq_protocol::{SessionGoal, SessionGoalStatus, SessionGoalUpdate};
use rusqlite::{params, OptionalExtension};

use super::{now_iso, MemoryError, Result, Store};

fn parse_status(value: &str) -> rusqlite::Result<SessionGoalStatus> {
    match value {
        "active" => Ok(SessionGoalStatus::Active),
        "completed" => Ok(SessionGoalStatus::Completed),
        "paused" => Ok(SessionGoalStatus::Paused),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                other.to_string(),
            )),
        )),
    }
}

fn row_to_goal(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionGoal> {
    Ok(SessionGoal {
        session_id: row.get(0)?,
        goal: row.get(1)?,
        status: parse_status(&row.get::<_, String>(2)?)?,
        token_budget: row.get(3)?,
        used_tokens: row.get(4)?,
        used_time_ms: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

impl Store {
    pub fn session_goal(&self, session_id: &str) -> Result<Option<SessionGoal>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT session_id, goal, status, token_budget, used_tokens, used_time_ms, created_at, updated_at
             FROM session_goals WHERE session_id = ?1",
            [session_id], row_to_goal,
        ).optional().map_err(Into::into)
    }

    pub fn update_session_goal(&self, update: &SessionGoalUpdate) -> Result<SessionGoal> {
        if update.goal.trim().is_empty() {
            return Err(MemoryError::InvalidData("goal must not be empty".into()));
        }
        if update
            .token_budget
            .is_some_and(|budget| budget > i64::MAX as u64)
        {
            return Err(MemoryError::InvalidData(
                "token budget exceeds the storage limit".into(),
            ));
        }
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO session_goals (session_id, goal, status, token_budget, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(session_id) DO UPDATE SET goal=?2, status=?3, token_budget=?4, updated_at=?5",
            params![update.session_id, update.goal.trim(), format_status(update.status), update.token_budget.map(|v| v as i64), now],
        )?;
        conn.query_row(
            "SELECT session_id, goal, status, token_budget, used_tokens, used_time_ms, created_at, updated_at
             FROM session_goals WHERE session_id = ?1", [&update.session_id], row_to_goal,
        ).map_err(Into::into)
    }

    pub fn update_session_goal_usage(
        &self,
        session_id: &str,
        used_tokens: u64,
        elapsed_ms: u64,
    ) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE session_goals SET used_tokens = used_tokens + ?2, used_time_ms = used_time_ms + ?3, updated_at = ?4 WHERE session_id = ?1",
            params![session_id, used_tokens as i64, elapsed_ms as i64, now_iso()],
        )?;
        Ok(())
    }

    pub fn record_session_goal_usage(&self, session_id: &str, elapsed_ms: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let mut statement =
            conn.prepare("SELECT record_json FROM model_calls WHERE session_id = ?1")?;
        let mut tokens = 0u64;
        let mut has_usage = false;
        for raw in statement.query_map([session_id], |row| row.get::<_, String>(0))? {
            let value: serde_json::Value = serde_json::from_str(&raw?)?;
            if let Some(usage) = value
                .get("response")
                .and_then(|response| response.get("usage"))
            {
                // A model call row contains the final cumulative usage for one
                // provider request. Sum calls; taking the maximum would lose
                // usage whenever a turn makes multiple model requests.
                if let Some(call_tokens) = usage_tokens(usage) {
                    has_usage = true;
                    tokens = tokens.saturating_add(call_tokens);
                }
            }
        }
        drop(statement);
        let now = now_iso();
        if has_usage {
            conn.execute(
                "UPDATE session_goals SET used_tokens = ?2, used_time_ms = used_time_ms + ?3, updated_at = ?4 WHERE session_id = ?1",
                params![session_id, i64::try_from(tokens).unwrap_or(i64::MAX), i64::try_from(elapsed_ms).unwrap_or(i64::MAX), now],
            )?;
        } else {
            // Providers are allowed to omit usage (for example on a failed
            // stream). Preserve the known token total while still recording
            // the turn duration.
            conn.execute(
                "UPDATE session_goals SET used_time_ms = used_time_ms + ?2, updated_at = ?3 WHERE session_id = ?1",
                params![session_id, i64::try_from(elapsed_ms).unwrap_or(i64::MAX), now],
            )?;
        }
        Ok(())
    }
}

/// Extract the common provider usage shapes without treating a missing field
/// as zero. The returned value represents one model call, not a stream event.
fn usage_tokens(usage: &serde_json::Value) -> Option<u64> {
    let object = usage.as_object()?;
    for key in ["total_tokens", "totalTokens"] {
        if let Some(value) = object.get(key).and_then(serde_json::Value::as_u64) {
            return Some(value);
        }
    }
    let input = ["input_tokens", "prompt_tokens", "inputTokens"]
        .iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_u64));
    let output = ["output_tokens", "completion_tokens", "outputTokens"]
        .iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_u64));
    match (input, output) {
        (Some(input), Some(output)) => Some(input.saturating_add(output)),
        (Some(input), None) => Some(input),
        (None, Some(output)) => Some(output),
        (None, None) => None,
    }
}

fn format_status(status: SessionGoalStatus) -> &'static str {
    match status {
        SessionGoalStatus::Active => "active",
        SessionGoalStatus::Completed => "completed",
        SessionGoalStatus::Paused => "paused",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goals_are_session_scoped_and_usage_is_accumulated() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/goals", "goals").unwrap();
        let session = store.create_session(&workspace.id, "session").unwrap();
        let update = SessionGoalUpdate {
            session_id: session.id.clone(),
            goal: "ship the feature".into(),
            status: SessionGoalStatus::Active,
            token_budget: Some(1000),
        };
        let goal = store.update_session_goal(&update).unwrap();
        assert_eq!(goal.token_budget, Some(1000));
        store
            .update_session_goal_usage(&session.id, 12, 250)
            .unwrap();
        let current = store.session_goal(&session.id).unwrap().unwrap();
        assert_eq!(current.used_tokens, 12);
        assert_eq!(current.used_time_ms, 250);
    }

    #[test]
    fn goal_usage_sums_calls_and_preserves_tokens_when_provider_omits_usage() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/goals-usage", "goals").unwrap();
        let session = store.create_session(&workspace.id, "session").unwrap();
        store
            .update_session_goal(&SessionGoalUpdate {
                session_id: session.id.clone(),
                goal: "ship the feature".into(),
                status: SessionGoalStatus::Active,
                token_budget: None,
            })
            .unwrap();
        for (id, usage) in [
            ("call-1", serde_json::json!({"total_tokens": 100})),
            (
                "call-2",
                serde_json::json!({"input_tokens": 20, "output_tokens": 30}),
            ),
        ] {
            store
                .conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO model_calls (id, session_id, started_at, status, record_json) VALUES (?1, ?2, ?3, 'completed', ?4)",
                    rusqlite::params![
                        id,
                        session.id,
                        format!("2026-01-01T00:00:0{}Z", &id[id.len() - 1..]),
                        serde_json::json!({"response":{"usage": usage}}).to_string()
                    ],
                )
                .unwrap();
        }
        store.record_session_goal_usage(&session.id, 100).unwrap();
        let current = store.session_goal(&session.id).unwrap().unwrap();
        assert_eq!(current.used_tokens, 150);
        assert_eq!(current.used_time_ms, 100);

        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE model_calls SET record_json = '{\"response\":{}}' WHERE session_id = ?1",
                [&session.id],
            )
            .unwrap();
        store.record_session_goal_usage(&session.id, 50).unwrap();
        let current = store.session_goal(&session.id).unwrap().unwrap();
        assert_eq!(current.used_tokens, 150);
        assert_eq!(current.used_time_ms, 150);

        let error = store
            .update_session_goal(&SessionGoalUpdate {
                session_id: session.id,
                goal: "ship the feature".into(),
                status: SessionGoalStatus::Active,
                token_budget: Some(u64::MAX),
            })
            .unwrap_err();
        assert!(error.to_string().contains("storage limit"));
    }
}
