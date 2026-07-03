//! SQLite store. One connection guarded by a mutex; the daemon wraps this in
//! an `Arc` and calls it from blocking-friendly contexts.

use std::path::Path;
use std::sync::Mutex;

use miniq_protocol::{
    Approval, ApprovalStatus, Artifact, Message, RiskLevel, Role, Session, SessionStatus,
    ToolCall, ToolCallStatus, Workspace,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../../../migrations/0001_init.sql")),
    (
        "0002_artifacts_checkpoints",
        include_str!("../../../migrations/0002_artifacts_checkpoints.sql"),
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
                    |r| r.get(0),
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

    // ---- workspaces ----

    pub fn create_workspace(&self, path: &str, name: &str) -> Result<Workspace> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        // Reuse an existing workspace for the same path.
        if let Some(ws) = conn
            .query_row(
                "SELECT id, path, name, created_at, updated_at FROM workspaces WHERE path = ?1",
                params![path],
                row_to_workspace,
            )
            .optional()?
        {
            return Ok(ws);
        }
        let ws = Workspace {
            id: new_id("ws"),
            path: path.to_string(),
            name: name.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO workspaces (id, path, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![ws.id, ws.path, ws.name, ws.created_at, ws.updated_at],
        )?;
        Ok(ws)
    }

    pub fn get_workspace(&self, id: &str) -> Result<Workspace> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, path, name, created_at, updated_at FROM workspaces WHERE id = ?1",
            params![id],
            row_to_workspace,
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("workspace {id}")))
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, path, name, created_at, updated_at FROM workspaces ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_workspace)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ---- sessions ----

    pub fn create_session(&self, workspace_id: &str, title: &str) -> Result<Session> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let session = Session {
            id: new_id("sess"),
            workspace_id: workspace_id.to_string(),
            title: title.to_string(),
            status: SessionStatus::Idle,
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session.id,
                session.workspace_id,
                session.title,
                session.status.as_str(),
                session.created_at,
                session.updated_at
            ],
        )?;
        Ok(session)
    }

    pub fn get_session(&self, id: &str) -> Result<Session> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, workspace_id, title, status, created_at, updated_at
             FROM sessions WHERE id = ?1",
            params![id],
            row_to_session,
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("session {id}")))
    }

    pub fn list_sessions(&self, workspace_id: Option<&str>) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        match workspace_id {
            Some(ws) => {
                let mut stmt = conn.prepare(
                    "SELECT id, workspace_id, title, status, created_at, updated_at
                     FROM sessions WHERE workspace_id = ?1 ORDER BY updated_at DESC",
                )?;
                let rows = stmt.query_map(params![ws], row_to_session)?;
                Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, workspace_id, title, status, created_at, updated_at
                     FROM sessions ORDER BY updated_at DESC",
                )?;
                let rows = stmt.query_map([], row_to_session)?;
                Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
            }
        }
    }

    pub fn update_session_status(&self, id: &str, status: SessionStatus) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status.as_str(), now_iso()],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn update_session_title(&self, id: &str, title: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sessions SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now_iso()],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    // ---- messages ----

    pub fn append_message(&self, session_id: &str, role: Role, content: &str) -> Result<Message> {
        self.append_message_with_id(&new_id("msg"), session_id, role, content)
    }

    /// Append a message with a caller-allocated id (used for streaming, where
    /// the id is announced in delta events before the row exists).
    pub fn append_message_with_id(
        &self,
        id: &str,
        session_id: &str,
        role: Role,
        content: &str,
    ) -> Result<Message> {
        let conn = self.conn.lock().unwrap();
        let msg = Message {
            id: id.to_string(),
            session_id: session_id.to_string(),
            role,
            content: content.to_string(),
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![msg.id, msg.session_id, msg.role.as_str(), msg.content, msg.created_at],
        )?;
        conn.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![session_id, now_iso()],
        )?;
        Ok(msg)
    }

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, created_at
             FROM messages WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], row_to_message)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ---- tool calls ----

    pub fn create_tool_call(
        &self,
        session_id: &str,
        tool_name: &str,
        input: &Value,
        status: ToolCallStatus,
    ) -> Result<ToolCall> {
        let conn = self.conn.lock().unwrap();
        let call = ToolCall {
            id: new_id("tool"),
            session_id: session_id.to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
            output: None,
            status,
            created_at: now_iso(),
            completed_at: None,
        };
        conn.execute(
            "INSERT INTO tool_calls (id, session_id, tool_name, input_json, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                call.id,
                call.session_id,
                call.tool_name,
                serde_json::to_string(&call.input)?,
                call.status.as_str(),
                call.created_at
            ],
        )?;
        Ok(call)
    }

    pub fn finish_tool_call(
        &self,
        id: &str,
        status: ToolCallStatus,
        output: Option<&Value>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let output_json = output.map(serde_json::to_string).transpose()?;
        let n = conn.execute(
            "UPDATE tool_calls SET status = ?2, output_json = ?3, completed_at = ?4 WHERE id = ?1",
            params![id, status.as_str(), output_json, now_iso()],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!("tool_call {id}")));
        }
        Ok(())
    }

    pub fn update_tool_call_status(&self, id: &str, status: ToolCallStatus) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE tool_calls SET status = ?2 WHERE id = ?1",
            params![id, status.as_str()],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!("tool_call {id}")));
        }
        Ok(())
    }

    pub fn list_tool_calls(&self, session_id: &str) -> Result<Vec<ToolCall>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, tool_name, input_json, output_json, status, created_at, completed_at
             FROM tool_calls WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], row_to_tool_call)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    // ---- approvals ----

    pub fn create_approval(
        &self,
        session_id: &str,
        tool_call_id: &str,
        risk_level: RiskLevel,
        reason: &str,
    ) -> Result<Approval> {
        let conn = self.conn.lock().unwrap();
        let approval = Approval {
            id: new_id("appr"),
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            risk_level,
            status: ApprovalStatus::Pending,
            reason: reason.to_string(),
            created_at: now_iso(),
            resolved_at: None,
        };
        conn.execute(
            "INSERT INTO approvals (id, session_id, tool_call_id, risk_level, status, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                approval.id,
                approval.session_id,
                approval.tool_call_id,
                approval.risk_level.as_str(),
                approval.status.as_str(),
                approval.reason,
                approval.created_at
            ],
        )?;
        Ok(approval)
    }

    pub fn resolve_approval(&self, id: &str, status: ApprovalStatus) -> Result<Approval> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE approvals SET status = ?2, resolved_at = ?3 WHERE id = ?1 AND status = 'pending'",
            params![id, status.as_str(), now_iso()],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!("pending approval {id}")));
        }
        conn.query_row(
            "SELECT id, session_id, tool_call_id, risk_level, status, reason, created_at, resolved_at
             FROM approvals WHERE id = ?1",
            params![id],
            row_to_approval,
        )
        .map_err(Into::into)
    }

    // ---- artifacts ----

    pub fn create_artifact(
        &self,
        session_id: &str,
        path: &str,
        kind: &str,
        title: &str,
    ) -> Result<Artifact> {
        let conn = self.conn.lock().unwrap();
        let artifact = Artifact {
            id: new_id("art"),
            session_id: session_id.to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO artifacts (id, session_id, path, kind, title, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                artifact.id,
                artifact.session_id,
                artifact.path,
                artifact.kind,
                artifact.title,
                artifact.created_at
            ],
        )?;
        Ok(artifact)
    }

    pub fn list_artifacts(&self, session_id: &str) -> Result<Vec<Artifact>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, path, kind, title, created_at
             FROM artifacts WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Artifact {
                id: row.get(0)?,
                session_id: row.get(1)?,
                path: row.get(2)?,
                kind: row.get(3)?,
                title: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ---- checkpoints ----

    pub fn create_checkpoint(
        &self,
        session_id: &str,
        tool_call_id: &str,
        abs_path: &str,
        existed: bool,
        backup_path: Option<&str>,
    ) -> Result<CheckpointRow> {
        let conn = self.conn.lock().unwrap();
        let row = CheckpointRow {
            id: new_id("ckpt"),
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            abs_path: abs_path.to_string(),
            existed,
            backup_path: backup_path.map(|s| s.to_string()),
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO checkpoints (id, session_id, tool_call_id, abs_path, existed, backup_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.id,
                row.session_id,
                row.tool_call_id,
                row.abs_path,
                row.existed as i64,
                row.backup_path,
                row.created_at
            ],
        )?;
        Ok(row)
    }

    pub fn get_checkpoint(&self, id: &str) -> Result<CheckpointRow> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, session_id, tool_call_id, abs_path, existed, backup_path, created_at
             FROM checkpoints WHERE id = ?1",
            params![id],
            |row| {
                Ok(CheckpointRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    tool_call_id: row.get(2)?,
                    abs_path: row.get(3)?,
                    existed: row.get::<_, i64>(4)? != 0,
                    backup_path: row.get(5)?,
                    created_at: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| MemoryError::NotFound(format!("checkpoint {id}")))
    }

    // ---- memories ----

    pub fn create_memory(
        &self,
        workspace_id: Option<&str>,
        scope: &str,
        content: &str,
    ) -> Result<MemoryRow> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let row = MemoryRow {
            id: new_id("mem"),
            workspace_id: workspace_id.map(|s| s.to_string()),
            scope: scope.to_string(),
            content: content.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO memories (id, workspace_id, scope, content, metadata_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6)",
            params![row.id, row.workspace_id, row.scope, row.content, row.created_at, row.updated_at],
        )?;
        Ok(row)
    }

    /// Substring search over memories visible to a workspace: its own rows
    /// plus global-scope rows.
    pub fn search_memories(
        &self,
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRow>> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, scope, content, created_at, updated_at FROM memories
             WHERE content LIKE ?1 ESCAPE '\\'
               AND (scope = 'global' OR workspace_id IS ?2 OR ?2 IS NULL)
             ORDER BY updated_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![pattern, workspace_id, limit as i64], |row| {
            Ok(MemoryRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                scope: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ---- audit ----

    pub fn append_audit_event(
        &self,
        session_id: Option<&str>,
        event_type: &str,
        payload: &Value,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO audit_events (id, session_id, event_type, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                new_id("audit"),
                session_id,
                event_type,
                serde_json::to_string(payload)?,
                now_iso()
            ],
        )?;
        Ok(())
    }

    pub fn count_audit_events(&self, session_id: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let n: u64 = conn.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(n)
    }
}

// ---- row mappers ----

fn parse_session_status(s: &str) -> rusqlite::Result<SessionStatus> {
    match s {
        "idle" => Ok(SessionStatus::Idle),
        "running" => Ok(SessionStatus::Running),
        "waiting_approval" => Ok(SessionStatus::WaitingApproval),
        "cancelling" => Ok(SessionStatus::Cancelling),
        "failed" => Ok(SessionStatus::Failed),
        other => Err(invalid_text(format!("session status {other}"))),
    }
}

fn parse_role(s: &str) -> rusqlite::Result<Role> {
    match s {
        "user" => Ok(Role::User),
        "assistant" => Ok(Role::Assistant),
        "system" => Ok(Role::System),
        "tool" => Ok(Role::Tool),
        other => Err(invalid_text(format!("role {other}"))),
    }
}

fn parse_tool_call_status(s: &str) -> rusqlite::Result<ToolCallStatus> {
    match s {
        "pending" => Ok(ToolCallStatus::Pending),
        "waiting_approval" => Ok(ToolCallStatus::WaitingApproval),
        "running" => Ok(ToolCallStatus::Running),
        "succeeded" => Ok(ToolCallStatus::Succeeded),
        "failed" => Ok(ToolCallStatus::Failed),
        "rejected" => Ok(ToolCallStatus::Rejected),
        "cancelled" => Ok(ToolCallStatus::Cancelled),
        other => Err(invalid_text(format!("tool call status {other}"))),
    }
}

fn parse_risk_level(s: &str) -> rusqlite::Result<RiskLevel> {
    match s {
        "low" => Ok(RiskLevel::Low),
        "medium" => Ok(RiskLevel::Medium),
        "high" => Ok(RiskLevel::High),
        "blocked" => Ok(RiskLevel::Blocked),
        other => Err(invalid_text(format!("risk level {other}"))),
    }
}

fn parse_approval_status(s: &str) -> rusqlite::Result<ApprovalStatus> {
    match s {
        "pending" => Ok(ApprovalStatus::Pending),
        "approved" => Ok(ApprovalStatus::Approved),
        "approved_for_session" => Ok(ApprovalStatus::ApprovedForSession),
        "rejected" => Ok(ApprovalStatus::Rejected),
        other => Err(invalid_text(format!("approval status {other}"))),
    }
}

fn invalid_text(msg: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, msg)),
    )
}

fn parse_json(s: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row_to_workspace(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    let status: String = row.get(3)?;
    Ok(Session {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        status: parse_session_status(&status)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    let role: String = row.get(2)?;
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: parse_role(&role)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn row_to_tool_call(row: &Row<'_>) -> rusqlite::Result<ToolCall> {
    let input_json: String = row.get(3)?;
    let output_json: Option<String> = row.get(4)?;
    let status: String = row.get(5)?;
    Ok(ToolCall {
        id: row.get(0)?,
        session_id: row.get(1)?,
        tool_name: row.get(2)?,
        input: parse_json(input_json)?,
        output: output_json.map(parse_json).transpose()?,
        status: parse_tool_call_status(&status)?,
        created_at: row.get(6)?,
        completed_at: row.get(7)?,
    })
}

fn row_to_approval(row: &Row<'_>) -> rusqlite::Result<Approval> {
    let risk: String = row.get(3)?;
    let status: String = row.get(4)?;
    Ok(Approval {
        id: row.get(0)?,
        session_id: row.get(1)?,
        tool_call_id: row.get(2)?,
        risk_level: parse_risk_level(&risk)?,
        status: parse_approval_status(&status)?,
        reason: row.get(5)?,
        created_at: row.get(6)?,
        resolved_at: row.get(7)?,
    })
}
