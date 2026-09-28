use miniq_protocol::SessionModelSettings;
use rusqlite::{params, OptionalExtension};

use super::{Result, Store};

impl Store {
    pub fn session_approval_mode(
        &self,
        session_id: &str,
    ) -> Result<Option<miniq_protocol::ApprovalMode>> {
        self.get_session(session_id)?;
        let raw: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT mode FROM session_approval_settings WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_value(serde_json::Value::String(raw)).map_err(Into::into))
            .transpose()
    }

    pub fn set_session_approval_mode(
        &self,
        session_id: &str,
        mode: Option<miniq_protocol::ApprovalMode>,
    ) -> Result<()> {
        self.get_session(session_id)?;
        let conn = self.conn.lock().unwrap();
        if let Some(mode) = mode {
            conn.execute(
                "INSERT INTO session_approval_settings (session_id, mode) VALUES (?1, ?2)
              ON CONFLICT(session_id) DO UPDATE SET mode = excluded.mode",
                params![session_id, serde_json::to_value(mode)?.as_str()],
            )?;
        } else {
            conn.execute(
                "DELETE FROM session_approval_settings WHERE session_id = ?1",
                params![session_id],
            )?;
        }
        Ok(())
    }

    pub fn session_plan(&self, session_id: &str) -> Result<Vec<miniq_protocol::PlanTask>> {
        self.get_session(session_id)?;
        let raw: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT tasks_json FROM session_plans WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    /// Persist the current plan and bind it to the turn that produced it.
    /// Returns the anchoring user message, when the session has one.
    pub fn set_session_plan(
        &self,
        session_id: &str,
        plan: &[miniq_protocol::PlanTask],
    ) -> Result<Option<String>> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let tasks_json = serde_json::to_string(plan)?;
        transaction.execute(
            "INSERT INTO session_plans (session_id, tasks_json) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET tasks_json = excluded.tasks_json",
            params![session_id, tasks_json],
        )?;
        let anchor: Option<String> = transaction
            .query_row(
                "SELECT id FROM messages WHERE session_id = ?1 AND role = 'user'
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(anchor) = &anchor {
            transaction.execute(
                "INSERT INTO turn_plans (session_id, anchor_message_id, tasks_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id, anchor_message_id) DO UPDATE
                 SET tasks_json = excluded.tasks_json, updated_at = excluded.updated_at",
                params![session_id, anchor, tasks_json, super::now_iso()],
            )?;
        }
        transaction.commit()?;
        Ok(anchor)
    }

    /// Every turn's latest plan, oldest turn first.
    pub fn session_turn_plans(&self, session_id: &str) -> Result<Vec<miniq_protocol::TurnPlan>> {
        self.get_session(session_id)?;
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT p.anchor_message_id, p.tasks_json, p.updated_at FROM turn_plans p
             JOIN messages m ON m.id = p.anchor_message_id AND m.session_id = p.session_id
             WHERE p.session_id = ?1 ORDER BY m.created_at, m.rowid",
        )?;
        let rows = statement
            .query_map(params![session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(anchor_message_id, tasks, updated_at)| {
                Ok(miniq_protocol::TurnPlan {
                    anchor_message_id,
                    tasks: serde_json::from_str(&tasks)?,
                    updated_at,
                })
            })
            .collect()
    }

    pub fn session_model_settings(&self, session_id: &str) -> Result<SessionModelSettings> {
        self.get_session(session_id)?;
        let conn = self.conn.lock().unwrap();
        let raw: Option<String> = conn
            .query_row(
                "SELECT settings_json FROM session_model_settings WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    pub fn workspace_model_settings(&self, workspace_id: &str) -> Result<SessionModelSettings> {
        self.get_workspace(workspace_id)?;
        let conn = self.conn.lock().unwrap();
        let raw: Option<String> = conn
            .query_row(
                "SELECT settings_json FROM workspace_model_settings WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    pub fn set_session_model_settings(
        &self,
        session_id: &str,
        settings: &SessionModelSettings,
    ) -> Result<()> {
        self.get_session(session_id)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO session_model_settings (session_id, settings_json) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![session_id, serde_json::to_string(settings)?],
        )?;
        Ok(())
    }

    pub fn set_workspace_model_settings(
        &self,
        workspace_id: &str,
        settings: &SessionModelSettings,
    ) -> Result<()> {
        self.get_workspace(workspace_id)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO workspace_model_settings (workspace_id, settings_json) VALUES (?1, ?2)
             ON CONFLICT(workspace_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![workspace_id, serde_json::to_string(settings)?],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::{ApiProtocol, ReasoningEffort};

    #[test]
    fn settings_are_isolated_durable_and_cascade() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("test.db");
        let store = Store::open(&db).unwrap();
        let workspace = store
            .create_workspace(dir.path().to_str().unwrap(), "test")
            .unwrap();
        let a = store.create_session(&workspace.id, "a").unwrap();
        let b = store.create_session(&workspace.id, "b").unwrap();
        let settings = SessionModelSettings {
            model: Some("gpt-5.6-sol".into()),
            api_protocol: ApiProtocol::Responses,
            reasoning_effort: Some(ReasoningEffort::High),
        };
        store.set_session_model_settings(&a.id, &settings).unwrap();
        store
            .set_session_approval_mode(&a.id, Some(miniq_protocol::ApprovalMode::AlwaysAsk))
            .unwrap();
        let plan = serde_json::from_value::<Vec<miniq_protocol::PlanTask>>(
            serde_json::json!([{ "content": "check", "status": "completed" }]),
        )
        .unwrap();
        store.set_session_plan(&a.id, &plan).unwrap();
        assert_eq!(
            store.session_model_settings(&b.id).unwrap(),
            SessionModelSettings::default()
        );
        drop(store);
        let store = Store::open(&db).unwrap();
        assert_eq!(
            store.session_approval_mode(&a.id).unwrap(),
            Some(miniq_protocol::ApprovalMode::AlwaysAsk)
        );
        assert_eq!(store.session_approval_mode(&b.id).unwrap(), None);
        assert_eq!(store.session_model_settings(&a.id).unwrap(), settings);
        assert_eq!(store.session_plan(&a.id).unwrap()[0].content, "check");
        assert!(store.session_plan(&b.id).unwrap().is_empty());
        store.delete_session(&a.id).unwrap();
        assert!(store.session_model_settings(&a.id).is_err());
        assert!(store
            .set_session_model_settings("missing", &settings)
            .is_err());
    }

    #[test]
    fn plans_stay_bound_to_the_turn_that_published_them() {
        use miniq_protocol::{PlanTask, Role};
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/fixture", "fixture").unwrap();
        let session = store.create_session(&workspace.id, "s").unwrap();
        let plan = |text: &str| {
            serde_json::from_value::<Vec<PlanTask>>(
                serde_json::json!([{ "content": text, "status": "in_progress" }]),
            )
            .unwrap()
        };
        assert_eq!(store.set_session_plan(&session.id, &plan("orphan")).unwrap(), None);
        let first = store.append_message(&session.id, Role::User, "one").unwrap();
        assert_eq!(
            store.set_session_plan(&session.id, &plan("a")).unwrap(),
            Some(first.id.clone())
        );
        store.set_session_plan(&session.id, &plan("a2")).unwrap();
        let answer = store.append_message(&session.id, Role::Assistant, "done").unwrap();
        let second = store.append_message(&session.id, Role::User, "two").unwrap();
        store.set_session_plan(&session.id, &plan("b")).unwrap();

        let turns = store.session_turn_plans(&session.id).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].anchor_message_id, first.id);
        assert_eq!(turns[0].tasks[0].content, "a2");
        assert_eq!(turns[1].anchor_message_id, second.id);
        assert_eq!(turns[1].tasks[0].content, "b");

        store
            .rewrite_session_from_user_message(&session.id, &second.id, "two again", &[])
            .unwrap();
        let turns = store.session_turn_plans(&session.id).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].anchor_message_id, first.id);

        let fork = store.fork_session(&session.id, &answer.id, None).unwrap();
        let forked = store.session_turn_plans(&fork.id).unwrap();
        assert_eq!(forked.len(), 1);
        assert_ne!(forked[0].anchor_message_id, first.id);
        assert_eq!(forked[0].tasks[0].content, "a2");
    }

    #[test]
    fn workspace_defaults_only_apply_to_new_sessions() {
        let store = Store::open_in_memory().unwrap();
        let first_workspace = store.create_workspace("/first", "first").unwrap();
        let second_workspace = store.create_workspace("/second", "second").unwrap();
        let first = store.create_session(&first_workspace.id, "first").unwrap();
        let existing = store
            .create_session(&first_workspace.id, "existing")
            .unwrap();
        let unrelated = store
            .create_session(&second_workspace.id, "unrelated")
            .unwrap();
        let settings = SessionModelSettings {
            model: Some("gpt-5.6-sol".into()),
            api_protocol: ApiProtocol::Responses,
            reasoning_effort: Some(ReasoningEffort::High),
        };
        let explicit = SessionModelSettings {
            model: Some("claude-sonnet-4.6".into()),
            api_protocol: ApiProtocol::AnthropicMessages,
            reasoning_effort: None,
        };
        store
            .set_session_model_settings(&first.id, &explicit)
            .unwrap();

        store
            .set_workspace_model_settings(&first_workspace.id, &settings)
            .unwrap();
        let inherited = store
            .create_session(&first_workspace.id, "inherited")
            .unwrap();

        assert_eq!(store.session_model_settings(&first.id).unwrap(), explicit);
        assert_eq!(
            store.session_model_settings(&inherited.id).unwrap(),
            settings
        );
        assert_eq!(
            store.session_model_settings(&existing.id).unwrap(),
            SessionModelSettings::default()
        );
        assert_eq!(
            store.session_model_settings(&unrelated.id).unwrap(),
            SessionModelSettings::default()
        );
    }

    #[test]
    fn session_creation_persists_its_own_model_without_changing_defaults_or_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("sessions.db");
        let store = Store::open(&db).unwrap();
        let first_workspace = store.create_workspace("/first", "first").unwrap();
        let first = store.create_session(&first_workspace.id, "first").unwrap();
        let settings = SessionModelSettings {
            model: Some("new-session-model".into()),
            api_protocol: ApiProtocol::Responses,
            reasoning_effort: Some(ReasoningEffort::High),
        };

        let second = store
            .create_session_with_model_settings(&first_workspace.id, "second", Some(&settings))
            .unwrap();
        drop(store);
        let store = Store::open(&db).unwrap();

        assert_eq!(
            store.workspace_model_settings(&first_workspace.id).unwrap(),
            SessionModelSettings::default()
        );
        assert_eq!(
            store.session_model_settings(&first.id).unwrap(),
            SessionModelSettings::default()
        );
        assert_eq!(store.session_model_settings(&second.id).unwrap(), settings);
        let third = store.create_session(&first_workspace.id, "third").unwrap();
        assert_eq!(
            store.session_model_settings(&third.id).unwrap(),
            SessionModelSettings::default()
        );
    }
}
