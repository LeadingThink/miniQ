use miniq_protocol::{
    Approval, ApprovalStatus, Message, RiskLevel, Role, ToolCall, ToolCallStatus,
};
use rusqlite::params;
use serde_json::Value;

use super::row_mappers::{row_to_approval, row_to_message, row_to_tool_call};
use super::{new_id, now_iso, MemoryError, Result, Store};

#[derive(Debug, Clone)]
pub struct PendingApprovalRequest {
    pub approval: Approval,
    pub tool_name: String,
    pub input: Value,
}

impl Store {
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
        let message = Message {
            id: id.to_string(),
            session_id: session_id.to_string(),
            role,
            content: content.to_string(),
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                message.id,
                message.session_id,
                message.role.as_str(),
                message.content,
                message.created_at
            ],
        )?;
        conn.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![session_id, now_iso()],
        )?;
        Ok(message)
    }

    pub fn list_messages(&self, session_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.session_id, m.role, m.content, m.created_at
             FROM messages m
             LEFT JOIN external_session_events e ON e.projected_message_id = m.id
             WHERE m.session_id = ?1
             ORDER BY
               CASE WHEN e.sequence IS NULL THEN 1 ELSE 0 END ASC,
               e.sequence ASC,
               m.created_at ASC,
               m.id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], row_to_message)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Case-insensitive substring search across message contents. Returns the
    /// most recent match per session, newest first.
    pub fn search_messages(&self, query: &str, limit: usize) -> Result<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let mut stmt = conn.prepare(
            // SQLite bare-column semantics: with MAX() in the select list,
            // the other columns come from the row where the max occurs, so
            // this yields the latest matching message per session.
            "SELECT id, session_id, role, content, MAX(created_at) AS created_at
             FROM messages
             WHERE content LIKE ?1 ESCAPE '\\' AND role IN ('user', 'assistant')
             GROUP BY session_id
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit as i64], row_to_message)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn create_tool_call(
        &self,
        session_id: &str,
        tool_name: &str,
        input: &Value,
        status: ToolCallStatus,
    ) -> Result<ToolCall> {
        let conn = self.conn.lock().unwrap();
        let tool_call = ToolCall {
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
                tool_call.id,
                tool_call.session_id,
                tool_call.tool_name,
                serde_json::to_string(&tool_call.input)?,
                tool_call.status.as_str(),
                tool_call.created_at
            ],
        )?;
        Ok(tool_call)
    }

    pub fn finish_tool_call(
        &self,
        id: &str,
        status: ToolCallStatus,
        output: Option<&Value>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let output_json = output.map(serde_json::to_string).transpose()?;
        let updated = conn.execute(
            "UPDATE tool_calls SET status = ?2, output_json = ?3, completed_at = ?4 WHERE id = ?1",
            params![id, status.as_str(), output_json, now_iso()],
        )?;
        if updated == 0 {
            return Err(MemoryError::NotFound(format!("tool_call {id}")));
        }
        Ok(())
    }

    pub fn update_tool_call_status(&self, id: &str, status: ToolCallStatus) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE tool_calls SET status = ?2 WHERE id = ?1",
            params![id, status.as_str()],
        )?;
        if updated == 0 {
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
        let updated = conn.execute(
            "UPDATE approvals SET status = ?2, resolved_at = ?3 WHERE id = ?1 AND status = 'pending'",
            params![id, status.as_str(), now_iso()],
        )?;
        if updated == 0 {
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

    pub fn list_pending_approval_requests(
        &self,
        session_id: &str,
    ) -> Result<Vec<PendingApprovalRequest>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT a.id, a.session_id, a.tool_call_id, a.risk_level, a.status,
                    a.reason, a.created_at, a.resolved_at, t.tool_name, t.input_json
             FROM approvals a
             JOIN tool_calls t ON t.id = a.tool_call_id
             WHERE a.session_id = ?1 AND a.status = 'pending'
             ORDER BY a.created_at ASC, a.id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let approval = row_to_approval(row)?;
            let input_json: String = row.get(9)?;
            let input = serde_json::from_str(&input_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    9,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(PendingApprovalRequest {
                approval,
                tool_name: row.get(8)?,
                input,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}
