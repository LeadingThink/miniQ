//! Durable conversation forks.
//!
//! A fork is a new local session containing only records that existed at a
//! selected assistant reply. It is deliberately one SQLite transaction so a
//! partially copied conversation can never become visible to a client.

use std::collections::HashMap;

use miniq_protocol::{Session, SessionStatus};
use rusqlite::{params, OptionalExtension, Transaction};

use super::{new_id, now_iso, MemoryError, Result, Store};

impl Store {
    /// Fork `source_session_id` at a durable assistant message.
    ///
    /// Runtime state is intentionally not copied: queued messages, approvals,
    /// active session status, and in-flight tool calls stay in the source.
    /// Completed history, attachments, artifacts, agent checkpoints, plans,
    /// model settings, and a valid compacted context snapshot are copied.
    pub fn fork_session(
        &self,
        source_session_id: &str,
        anchor_message_id: &str,
        title: Option<&str>,
    ) -> Result<Session> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let (workspace_id, source_title, working_directory): (String, String, String) = transaction
            .query_row(
                "SELECT workspace_id, title, working_directory FROM sessions WHERE id = ?1",
                params![source_session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("session {source_session_id}")))?;
        let (anchor_created_at, anchor_role): (String, String) = transaction
            .query_row(
                "SELECT created_at, role FROM messages
                 WHERE id = ?1 AND session_id = ?2",
                params![anchor_message_id, source_session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("message {anchor_message_id}")))?;
        if anchor_role != "assistant" {
            return Err(MemoryError::InvalidData(
                "a conversation can only fork from an assistant reply".into(),
            ));
        }

        let target_id = new_id("sess");
        let now = now_iso();
        let target_title = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{source_title} · 分支"));
        transaction.execute(
            "INSERT INTO sessions
               (id, workspace_id, title, status, pinned, archived, created_at, updated_at, working_directory)
             VALUES (?1, ?2, ?3, 'idle', 0, 0, ?4, ?4, ?5)",
            params![target_id, workspace_id, target_title, now, working_directory],
        )?;

        let source_messages = load_messages(
            &transaction,
            source_session_id,
            &anchor_created_at,
            anchor_message_id,
        )?;
        let mut message_ids = HashMap::with_capacity(source_messages.len());
        for (id, role, content, attachments, created_at) in source_messages {
            let copied_id = new_id("msg");
            transaction.execute(
                "INSERT INTO messages (id, session_id, role, content, attachments_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![copied_id, target_id, role, content, attachments, created_at],
            )?;
            message_ids.insert(id, copied_id);
        }

        let source_agents = load_agent_tasks(
            &transaction,
            source_session_id,
            &anchor_created_at,
            anchor_message_id,
        )?;
        let mut agent_ids = HashMap::with_capacity(source_agents.len());
        for (id, name, parent_id, created_at, state, history, revision, result) in source_agents {
            let copied_id = new_id("agent");
            let copied_parent = parent_id
                .as_deref()
                .and_then(|parent| agent_ids.get(parent))
                .cloned();
            transaction.execute(
                "INSERT INTO agent_tasks
                   (id, session_id, name, parent_id, created_at, state_json, history_json, history_revision, result)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![copied_id, target_id, name, copied_parent, created_at, state, history, revision, result],
            )?;
            agent_ids.insert(id, copied_id);
        }

        for (_id, tool_name, input, output, status, created_at, completed_at, agent_id) in
            load_tool_calls(
                &transaction,
                source_session_id,
                &anchor_created_at,
                anchor_message_id,
            )?
        {
            let copied_agent = agent_id
                .as_deref()
                .and_then(|agent| agent_ids.get(agent))
                .cloned();
            transaction.execute(
                "INSERT INTO tool_calls
                   (id, session_id, tool_name, input_json, output_json, status, created_at, completed_at, agent_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![new_id("tool"), target_id, tool_name, input, output, status, created_at, completed_at, copied_agent],
            )?;
        }

        let artifacts = load_artifacts(
            &transaction,
            source_session_id,
            &anchor_created_at,
            anchor_message_id,
        )?;
        for (_id, path, kind, artifact_title, created_at) in artifacts {
            transaction.execute(
                "INSERT INTO artifacts (id, session_id, path, kind, title, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    new_id("art"),
                    target_id,
                    path,
                    kind,
                    artifact_title,
                    created_at
                ],
            )?;
        }

        transaction.execute(
            "INSERT INTO session_model_settings (session_id, settings_json)
             SELECT ?1, settings_json FROM session_model_settings WHERE session_id = ?2",
            params![target_id, source_session_id],
        )?;
        transaction.execute(
            "INSERT INTO session_approval_settings (session_id, mode)
             SELECT ?1, mode FROM session_approval_settings WHERE session_id = ?2",
            params![target_id, source_session_id],
        )?;
        transaction.execute(
            "INSERT INTO session_plans (session_id, tasks_json)
             SELECT ?1, tasks_json FROM session_plans WHERE session_id = ?2",
            params![target_id, source_session_id],
        )?;
        transaction.execute(
            "INSERT INTO session_goals (session_id, goal, status, token_budget, used_tokens, used_time_ms, created_at, updated_at)
             SELECT ?1, goal, status, token_budget, 0, 0, ?3, ?3
             FROM session_goals WHERE session_id = ?2",
            params![target_id, source_session_id, now],
        )?;

        // A compacted snapshot is safe only when its anchor was copied. This
        // avoids importing future context from a source turn still in flight.
        if let Some((last_message_id, history, updated_at, model_identity)) = transaction
            .query_row(
                "SELECT last_message_id, history_json, updated_at, model_identity
                 FROM model_context_snapshots WHERE session_id = ?1",
                params![source_session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?
        {
            if let Some(copied_anchor) = message_ids.get(&last_message_id) {
                transaction.execute(
                    "INSERT INTO model_context_snapshots
                       (session_id, last_message_id, history_json, updated_at, model_identity)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        target_id,
                        copied_anchor,
                        history,
                        updated_at,
                        model_identity
                    ],
                )?;
            }
        }

        let session = Session {
            id: target_id,
            workspace_id,
            working_directory,
            title: target_title,
            status: SessionStatus::Idle,
            pinned: false,
            archived: false,
            external: None,
            created_at: now.clone(),
            updated_at: now,
        };
        transaction.commit()?;
        Ok(session)
    }
}

fn load_messages(
    transaction: &Transaction<'_>,
    session_id: &str,
    anchor_at: &str,
    anchor_id: &str,
) -> Result<Vec<(String, String, String, String, String)>> {
    let mut statement = transaction.prepare(
        "SELECT id, role, content, attachments_json, created_at FROM messages
         WHERE session_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map(params![session_id, anchor_at, anchor_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_agent_tasks(
    transaction: &Transaction<'_>,
    session_id: &str,
    anchor_at: &str,
    anchor_id: &str,
) -> Result<
    Vec<(
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        i64,
        Option<String>,
    )>,
> {
    let mut statement = transaction.prepare(
        "SELECT id, name, parent_id, created_at, state_json, history_json, history_revision, result
         FROM agent_tasks WHERE session_id = ?1
           AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map(params![session_id, anchor_at, anchor_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
        ))
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_tool_calls(
    transaction: &Transaction<'_>,
    session_id: &str,
    anchor_at: &str,
    anchor_id: &str,
) -> Result<
    Vec<(
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
    )>,
> {
    let mut statement = transaction.prepare(
        "SELECT id, tool_name, input_json, output_json, status, created_at, completed_at, agent_id
         FROM tool_calls WHERE session_id = ?1
           AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
           AND status IN ('succeeded', 'failed', 'rejected', 'cancelled')
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map(params![session_id, anchor_at, anchor_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
        ))
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_artifacts(
    transaction: &Transaction<'_>,
    session_id: &str,
    anchor_at: &str,
    anchor_id: &str,
) -> Result<Vec<(String, String, String, String, String)>> {
    let mut statement = transaction.prepare(
        "SELECT id, path, kind, title, created_at FROM artifacts
         WHERE session_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map(params![session_id, anchor_at, anchor_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::{
        ApiProtocol, MessageAttachment, Role, SessionGoalStatus, SessionGoalUpdate,
        SessionModelSettings, ToolCallStatus,
    };
    use serde_json::json;

    #[test]
    fn forks_only_to_assistant_anchor_and_preserves_durable_context() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/work", "project").unwrap();
        let source = store.create_session(&workspace.id, "Original").unwrap();
        store
            .update_session_goal(&SessionGoalUpdate {
                session_id: source.id.clone(),
                goal: "ship the feature".into(),
                status: SessionGoalStatus::Active,
                token_budget: Some(1000),
            })
            .unwrap();
        store
            .update_session_goal_usage(&source.id, 42, 900)
            .unwrap();
        store
            .set_session_model_settings(
                &source.id,
                &SessionModelSettings {
                    model: Some("gpt-5.6-sol".into()),
                    api_protocol: ApiProtocol::Responses,
                    reasoning_effort: None,
                },
            )
            .unwrap();
        let user = store
            .append_message_with_attachments(
                &source.id,
                Role::User,
                "make a plan",
                &[MessageAttachment {
                    path: "/work/a.png".into(),
                    name: "a.png".into(),
                    mime_type: Some("image/png".into()),
                }],
            )
            .unwrap();
        let agent = crate::AgentTaskRow {
            id: new_id("agent"),
            session_id: source.id.clone(),
            name: "research".into(),
            parent_id: None,
            created_at: user.created_at.clone(),
            state: json!({"status":"completed"}),
        };
        store.create_agent_task(&agent).unwrap();
        let tool = store
            .create_tool_call(
                &source.id,
                "shell_run",
                &json!({"command":"echo ok"}),
                Some(&agent.id),
                ToolCallStatus::Succeeded,
            )
            .unwrap();
        store
            .finish_tool_call(
                &tool.id,
                ToolCallStatus::Succeeded,
                Some(&json!({"ok":true})),
            )
            .unwrap();
        store
            .create_artifact(&source.id, "/work/out.txt", "text", "out.txt")
            .unwrap();
        let assistant = store
            .append_message(&source.id, Role::Assistant, "done")
            .unwrap();
        let future = store
            .append_message(&source.id, Role::User, "future")
            .unwrap();
        store
            .save_model_context(
                &source.id,
                &assistant.id,
                &json!([{"role":"assistant","content":"done"}]),
                Some("gpt-5.6-sol"),
            )
            .unwrap();

        let fork = store.fork_session(&source.id, &assistant.id, None).unwrap();
        assert_eq!(fork.workspace_id, workspace.id);
        assert_eq!(
            store
                .session_model_settings(&fork.id)
                .unwrap()
                .model
                .as_deref(),
            Some("gpt-5.6-sol")
        );
        let messages = store.list_messages(&fork.id).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            ["make a plan", "done"]
        );
        assert_ne!(messages[0].id, user.id);
        assert!(messages[0].attachments[0].path.ends_with("a.png"));
        assert_eq!(store.list_tool_calls(&fork.id).unwrap().len(), 1);
        assert_eq!(store.list_artifacts(&fork.id).unwrap().len(), 1);
        assert!(store.get_model_context(&fork.id).unwrap().is_some());
        let fork_goal = store.session_goal(&fork.id).unwrap().unwrap();
        assert_eq!(fork_goal.goal, "ship the feature");
        assert_eq!(fork_goal.token_budget, Some(1000));
        assert_eq!(fork_goal.used_tokens, 0);
        assert_eq!(fork_goal.used_time_ms, 0);
        assert!(store
            .list_messages(&source.id)
            .unwrap()
            .iter()
            .any(|m| m.id == future.id));
        assert!(store.fork_session(&source.id, &user.id, None).is_err());
    }

    #[test]
    fn does_not_copy_in_flight_tools_or_pending_runtime_state() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/work", "project").unwrap();
        let source = store.create_session(&workspace.id, "Original").unwrap();
        let assistant = store
            .append_message(&source.id, Role::Assistant, "done")
            .unwrap();
        let running = store
            .create_tool_call(
                &source.id,
                "shell_run",
                &json!({}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        let fork = store
            .fork_session(&source.id, &assistant.id, Some("My branch"))
            .unwrap();
        assert_eq!(fork.title, "My branch");
        assert!(store.list_tool_calls(&fork.id).unwrap().is_empty());
        assert_eq!(
            store.get_session(&fork.id).unwrap().status,
            SessionStatus::Idle
        );
        assert!(store.get_tool_call(&running.id).is_ok());
    }
}
