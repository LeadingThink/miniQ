use miniq_protocol::{ApiProtocol, SessionModelSettings};
use rusqlite::params;

use super::{MemoryError, Result, Store};

const UPSERT_SESSION_SETTINGS: &str =
    "INSERT INTO session_model_settings (session_id, settings_json) VALUES (?1, ?2)
     ON CONFLICT(session_id) DO UPDATE SET settings_json = excluded.settings_json";

impl Store {
    /// Change creation defaults while preserving existing sessions' effective selections.
    /// `previous_defaults` must be the daemon's resolved selection before this update.
    pub fn update_model_defaults(
        &self,
        settings: &SessionModelSettings,
        previous_defaults: &SessionModelSettings,
        session_id: Option<&str>,
    ) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        if let Some(session_id) = session_id {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
                params![session_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(MemoryError::NotFound(format!("session {session_id}")));
            }
        }

        let sessions = {
            let mut statement = transaction.prepare(
                "SELECT s.id, m.settings_json FROM sessions s
                 LEFT JOIN session_model_settings m ON m.session_id = s.id
                 ORDER BY s.rowid",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        for (id, raw) in sessions {
            let selection: SessionModelSettings = raw
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?
                .unwrap_or_default();
            if selection.model.is_some() {
                continue;
            }
            // Match the daemon's apply_selection behavior for model-less selections.
            // Workspace settings only seed new sessions and do not participate here.
            let mut frozen = previous_defaults.clone();
            if selection.api_protocol != ApiProtocol::Auto {
                frozen.api_protocol = selection.api_protocol;
            }
            if selection != SessionModelSettings::default() {
                frozen.reasoning_effort = selection.reasoning_effort;
            }
            transaction.execute(
                UPSERT_SESSION_SETTINGS,
                params![id, serde_json::to_string(&frozen)?],
            )?;
        }

        let raw = serde_json::to_string(settings)?;
        if let Some(session_id) = session_id {
            transaction.execute(UPSERT_SESSION_SETTINGS, params![session_id, raw])?;
        }
        transaction.execute(
            "INSERT INTO workspace_model_settings (workspace_id, settings_json)
             SELECT id, ?1 FROM workspaces WHERE true
             ON CONFLICT(workspace_id) DO UPDATE SET settings_json = excluded.settings_json",
            params![raw],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
