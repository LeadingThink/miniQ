//! SQLite store. One connection guarded by a mutex; the daemon wraps this in
//! an `Arc` and calls it from blocking-friendly contexts.

mod agent_history;
mod agent_tasks;
mod approval_inbox;
mod conversation;
mod execution_events;
mod external_sessions;
mod history;
mod model_calls;
mod model_context;
mod queue;
mod records;
mod row_mappers;
mod scheduled_tasks;
mod session_settings;
mod workspace_roots;
mod workspaces;

pub use agent_tasks::AgentTaskRow;
pub use external_sessions::ExternalImportOutcome;
pub use model_context::ModelContextSnapshot;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

const MIGRATIONS: &[(&str, &str)] = &[
    // Entries are applied in order; append new migrations at the end.
    (
        "0001_init",
        include_str!("../../../migrations/0001_init.sql"),
    ),
    (
        "0002_artifacts_checkpoints",
        include_str!("../../../migrations/0002_artifacts_checkpoints.sql"),
    ),
    (
        "0003_scheduled_tasks",
        include_str!("../../../migrations/0003_scheduled_tasks.sql"),
    ),
    (
        "0004_external_sessions",
        include_str!("../../../migrations/0004_external_sessions.sql"),
    ),
    (
        "0005_pinned_sessions",
        include_str!("../../../migrations/0005_pinned_sessions.sql"),
    ),
    (
        "0006_model_context",
        include_str!("../../../migrations/0006_model_context.sql"),
    ),
    (
        "0007_queued_messages",
        include_str!("../../../migrations/0007_queued_messages.sql"),
    ),
    (
        "0008_message_attachments",
        include_str!("../../../migrations/0008_message_attachments.sql"),
    ),
    (
        "0009_session_model_settings",
        include_str!("../../../migrations/0009_session_model_settings.sql"),
    ),
    (
        "0010_workspace_roots",
        include_str!("../../../migrations/0010_workspace_roots.sql"),
    ),
    (
        "0011_model_calls",
        include_str!("../../../migrations/0011_model_calls.sql"),
    ),
    (
        "0012_agent_tasks",
        include_str!("../../../migrations/0012_agent_tasks.sql"),
    ),
    (
        "0013_session_approval",
        include_str!("../../../migrations/0013_session_approval.sql"),
    ),
    (
        "0014_workspace_model_settings",
        include_str!("../../../migrations/0014_workspace_model_settings.sql"),
    ),
];

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid data: {0}")]
    InvalidData(String),
}

pub type Result<T> = std::result::Result<T, MemoryError>;

/// Current UTC timestamp as RFC 3339 string.
pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("formatting utc now as rfc3339 cannot fail")
}

/// Generate a prefixed unique id (`msg_...`, `sess_...`).
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

/// Checkpoint record: a file backup taken before a write-type tool ran.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRow {
    pub id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub abs_path: String,
    pub existed: bool,
    pub backup_path: Option<String>,
    pub created_at: String,
}

/// Long-term memory row.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRow {
    pub id: String,
    pub workspace_id: Option<String>,
    pub scope: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Rows repaired when a daemon starts after the previous process exited
/// before it could finish active work.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StartupRecovery {
    pub sessions_failed: usize,
    pub tool_calls_cancelled: usize,
    pub approvals_rejected: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionRecovery {
    pub session_failed: bool,
    pub tool_calls_cancelled: usize,
    pub approvals_rejected: usize,
}

#[derive(Debug, Clone)]
pub struct SessionRewrite {
    pub message: miniq_protocol::Message,
    pub removed_message_ids: Vec<String>,
    pub removed_tool_call_ids: Vec<String>,
    pub removed_artifact_ids: Vec<String>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Open (or create) the database at `path` and apply pending migrations.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// In-memory store for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            );",
        )?;
        for (name, sql) in MIGRATIONS {
            let applied: Option<String> = conn
                .query_row(
                    "SELECT name FROM schema_migrations WHERE name = ?1",
                    params![name],
                    |row| row.get(0),
                )
                .optional()?;
            if applied.is_none() {
                if *name == "0014_workspace_model_settings"
                    && conn
                        .query_row(
                            "SELECT 1 FROM schema_migrations WHERE name = '0011_workspace_model_settings'",
                            [],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some()
                {
                    conn.execute(
                        "INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)",
                        params![name, now_iso()],
                    )?;
                    continue;
                }
                let transaction = conn.transaction()?;
                transaction.execute_batch(sql)?;
                transaction.execute(
                    "INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)",
                    params![name, now_iso()],
                )?;
                transaction.commit()?;
            }
        }
        Ok(())
    }

    /// Atomically mark process-owned in-flight state as terminal. None of
    /// these operations can still be running after a fresh daemon starts.
    pub fn recover_interrupted_work(&self) -> Result<StartupRecovery> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let now = now_iso();
        transaction.execute(
            "UPDATE agent_tasks SET state_json = json_set(state_json,
             '$.status', 'interrupted', '$.progress', NULL, '$.completedAt', ?1,
             '$.timingComplete', json('false'),
             '$.heldMessages', json((SELECT json_group_array(value) FROM (
                SELECT value FROM json_each(agent_tasks.state_json, '$.heldMessages')
                UNION ALL SELECT value FROM json_each(agent_tasks.state_json, '$.inbox')
             ))), '$.inbox', json('[]'),
             '$.error', 'daemon restarted; inspect recorded results before resuming')
             WHERE json_extract(state_json, '$.status') IN ('running', 'stopping', 'finalizing')",
            params![now],
        )?;
        transaction.execute(
            "UPDATE model_calls SET status = 'interrupted',
             record_json = json_set(record_json, '$.status', 'interrupted', '$.completedAt', ?1)
             WHERE status = 'running'",
            params![now],
        )?;
        let sessions_failed = transaction.execute(
            "UPDATE sessions
             SET status = 'failed', updated_at = ?1
             WHERE status IN ('running', 'waiting_approval', 'cancelling')",
            params![now],
        )?;
        let tool_calls_cancelled = transaction.execute(
            "UPDATE tool_calls
             SET status = 'cancelled', completed_at = ?1
             WHERE status IN ('pending', 'waiting_approval', 'running')",
            params![now],
        )?;
        let approvals_rejected = transaction.execute(
            "UPDATE approvals
             SET status = 'rejected', resolved_at = ?1
             WHERE status = 'pending'",
            params![now],
        )?;
        transaction.commit()?;
        Ok(StartupRecovery {
            sessions_failed,
            tool_calls_cancelled,
            approvals_rejected,
        })
    }

    /// Mark process-owned work for one session as terminal when no matching
    /// in-memory turn exists anymore.
    pub fn recover_interrupted_session(&self, session_id: &str) -> Result<SessionRecovery> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn.transaction()?;
        let now = now_iso();
        let session_failed = transaction.execute(
            "UPDATE sessions
             SET status = 'failed', updated_at = ?2
             WHERE id = ?1 AND status IN ('running', 'waiting_approval', 'cancelling')",
            params![session_id, now],
        )? > 0;
        let tool_calls_cancelled = transaction.execute(
            "UPDATE tool_calls
             SET status = 'cancelled', completed_at = ?2
             WHERE session_id = ?1 AND status IN ('pending', 'waiting_approval', 'running')",
            params![session_id, now],
        )?;
        let approvals_rejected = transaction.execute(
            "UPDATE approvals
             SET status = 'rejected', resolved_at = ?2
             WHERE session_id = ?1 AND status = 'pending'",
            params![session_id, now],
        )?;
        transaction.commit()?;
        Ok(SessionRecovery {
            session_failed,
            tool_calls_cancelled,
            approvals_rejected,
        })
    }
}
