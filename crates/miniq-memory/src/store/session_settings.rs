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

    pub fn set_session_plan(
        &self,
        session_id: &str,
        plan: &[miniq_protocol::PlanTask],
    ) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO session_plans (session_id, tasks_json) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET tasks_json = excluded.tasks_json",
            params![session_id, serde_json::to_string(plan)?],
        )?;
        Ok(())
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

    pub fn set_workspace_model_settings_for_session(
        &self,
        session_id: &str,
        settings: &SessionModelSettings,
    ) -> Result<()> {
        let workspace_id = self.get_session(session_id)?.workspace_id;
        self.set_workspace_model_settings(&workspace_id, settings)
    }

    pub fn set_workspace_model_settings(
        &self,
        workspace_id: &str,
        settings: &SessionModelSettings,
    ) -> Result<()> {
        self.get_workspace(workspace_id)?;
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let settings_json = serde_json::to_string(settings)?;
        transaction.execute(
            "INSERT INTO session_model_settings (session_id, settings_json)
             SELECT id, ?2 FROM sessions WHERE workspace_id = ?1
             ON CONFLICT(session_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![workspace_id, settings_json],
        )?;
        transaction.execute(
            "INSERT INTO workspace_model_settings (workspace_id, settings_json) VALUES (?1, ?2)
             ON CONFLICT(workspace_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![workspace_id, settings_json],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn set_global_model_settings(&self, settings: &SessionModelSettings) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let settings_json = serde_json::to_string(settings)?;
        transaction.execute(
            "INSERT INTO workspace_model_settings (workspace_id, settings_json)
             SELECT id, ?1 FROM workspaces WHERE true
             ON CONFLICT(workspace_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![settings_json],
        )?;
        transaction.execute(
            "INSERT INTO session_model_settings (session_id, settings_json)
             SELECT id, ?1 FROM sessions WHERE true
             ON CONFLICT(session_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![settings_json],
        )?;
        transaction.commit()?;
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
    fn workspace_model_settings_apply_to_existing_and_new_sessions() {
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

        store
            .set_workspace_model_settings(&first_workspace.id, &settings)
            .unwrap();
        let inherited = store
            .create_session(&first_workspace.id, "inherited")
            .unwrap();

        assert_eq!(store.session_model_settings(&first.id).unwrap(), settings);
        assert_eq!(
            store.session_model_settings(&inherited.id).unwrap(),
            settings
        );
        assert_eq!(
            store.session_model_settings(&existing.id).unwrap(),
            settings
        );
        assert_eq!(
            store.session_model_settings(&unrelated.id).unwrap(),
            SessionModelSettings::default()
        );
    }

    #[test]
    fn global_model_settings_apply_to_every_workspace_and_session() {
        let store = Store::open_in_memory().unwrap();
        let first_workspace = store.create_workspace("/first", "first").unwrap();
        let second_workspace = store.create_workspace("/second", "second").unwrap();
        let first = store.create_session(&first_workspace.id, "first").unwrap();
        let second = store
            .create_session(&second_workspace.id, "second")
            .unwrap();
        let settings = SessionModelSettings {
            model: Some("global-model".into()),
            api_protocol: ApiProtocol::Responses,
            reasoning_effort: Some(ReasoningEffort::High),
        };

        store.set_global_model_settings(&settings).unwrap();

        assert_eq!(
            store.workspace_model_settings(&first_workspace.id).unwrap(),
            settings
        );
        assert_eq!(
            store
                .workspace_model_settings(&second_workspace.id)
                .unwrap(),
            settings
        );
        assert_eq!(store.session_model_settings(&first.id).unwrap(), settings);
        assert_eq!(store.session_model_settings(&second.id).unwrap(), settings);
    }
}
