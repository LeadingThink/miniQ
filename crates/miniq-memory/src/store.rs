//! SQLite store. One connection guarded by a mutex; the daemon wraps this in
//! an `Arc` and calls it from blocking-friendly contexts.

mod conversation;
mod external_sessions;
mod records;
mod row_mappers;
mod scheduled_tasks;
mod workspaces;

pub use external_sessions::ExternalImportOutcome;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

const MIGRATIONS: &[(&str, &str)] = &[
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
        let conn = self.conn.lock().unwrap();
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
                conn.execute_batch(sql)?;
                conn.execute(
                    "INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)",
                    params![name, now_iso()],
                )?;
            }
        }
        Ok(())
    }
}
