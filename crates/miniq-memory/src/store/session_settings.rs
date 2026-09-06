use miniq_protocol::SessionModelSettings;
use rusqlite::{params, OptionalExtension};

use super::{Result, Store};

impl Store {
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
        assert_eq!(store.session_model_settings(&a.id).unwrap(), settings);
        assert_eq!(store.session_plan(&a.id).unwrap()[0].content, "check");
        assert!(store.session_plan(&b.id).unwrap().is_empty());
        store.delete_session(&a.id).unwrap();
        assert!(store.session_model_settings(&a.id).is_err());
        assert!(store
            .set_session_model_settings("missing", &settings)
            .is_err());
    }
}
