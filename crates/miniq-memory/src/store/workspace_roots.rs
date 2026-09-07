use rusqlite::params;

use super::{now_iso, MemoryError, Result, Store};

impl Store {
    /// Existing sessions keep their cwd. A directory in use must remain attached.
    pub fn update_workspace_roots(
        &self,
        id: &str,
        primary: &str,
        additional: &[String],
    ) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        {
            let mut statement = transaction
                .prepare("SELECT working_directory FROM sessions WHERE workspace_id = ?1")?;
            for directory in statement.query_map(params![id], |row| row.get::<_, String>(0))? {
                let directory = directory?;
                if directory != primary && !additional.contains(&directory) {
                    return Err(MemoryError::InvalidData(format!("directory is used by existing sessions and must remain attached: {directory}")));
                }
            }
        }
        let busy: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE workspace_id = ?1 AND status IN ('running', 'waiting_approval', 'cancelling'))",
            params![id], |row| row.get(0),
        )?;
        if busy {
            return Err(MemoryError::InvalidData(
                "project has active sessions".into(),
            ));
        }
        if transaction.execute(
            "UPDATE workspaces SET path = ?2, additional_paths_json = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, primary, serde_json::to_string(additional)?, now_iso()],
        )? == 0 { return Err(MemoryError::NotFound(format!("workspace {id}"))); }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_persist_and_primary_changes_only_affect_new_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("roots.db");
        let store = Store::open(&database).unwrap();
        let workspace = store.create_workspace("/primary", "project").unwrap();
        let old = store.create_session(&workspace.id, "old").unwrap();
        store
            .update_workspace_roots(&workspace.id, "/extra", &["/primary".into()])
            .unwrap();
        let new = store.create_session(&workspace.id, "new").unwrap();
        assert_eq!(new.working_directory, "/extra");
        assert_eq!(
            store.get_session(&old.id).unwrap().working_directory,
            "/primary"
        );
        assert!(store
            .update_workspace_roots(&workspace.id, "/extra", &[])
            .is_err());
        drop(store);
        let store = Store::open(&database).unwrap();
        let restored = store.get_workspace(&workspace.id).unwrap();
        assert_eq!(restored.path, "/extra");
        assert_eq!(restored.additional_paths, ["/primary"]);
        assert_eq!(
            store.get_session(&old.id).unwrap().working_directory,
            "/primary"
        );
    }

    #[test]
    fn busy_projects_cannot_change_roots() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/primary", "project").unwrap();
        let session = store.create_session(&workspace.id, "active").unwrap();
        for status in [
            miniq_protocol::SessionStatus::Running,
            miniq_protocol::SessionStatus::WaitingApproval,
            miniq_protocol::SessionStatus::Cancelling,
        ] {
            store.update_session_status(&session.id, status).unwrap();
            assert!(store
                .update_workspace_roots(&workspace.id, "/primary", &["/extra".into()])
                .is_err());
        }
        assert!(store
            .get_workspace(&workspace.id)
            .unwrap()
            .additional_paths
            .is_empty());
    }

    #[test]
    fn migration_backfills_existing_session_cwd() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("legacy.db");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
            )
            .unwrap();
        for (name, sql) in super::super::MIGRATIONS
            .iter()
            .filter(|(name, _)| *name != "0010_workspace_roots")
        {
            connection.execute_batch(sql).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations VALUES (?1, 'now')",
                    params![name],
                )
                .unwrap();
        }
        connection.execute_batch("INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES ('w', '/existing', 'old', 'now', 'now'); INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at) VALUES ('s', 'w', 'old', 'idle', 'now', 'now');").unwrap();
        drop(connection);
        let store = Store::open(&database).unwrap();
        assert_eq!(
            store.get_session("s").unwrap().working_directory,
            "/existing"
        );
        assert!(store
            .get_workspace("w")
            .unwrap()
            .additional_paths
            .is_empty());
    }
}
