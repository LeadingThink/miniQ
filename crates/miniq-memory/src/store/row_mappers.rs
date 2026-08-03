use miniq_protocol::{
    Approval, ApprovalStatus, ExternalContinuationMode, ExternalProvider, ExternalSessionLink,
    Message, RiskLevel, Role, ScheduledTask, Session, SessionStatus, ToolCall, ToolCallStatus,
    Workspace,
};
use rusqlite::Row;
use serde_json::Value;

fn parse_session_status(value: &str) -> rusqlite::Result<SessionStatus> {
    match value {
        "idle" => Ok(SessionStatus::Idle),
        "running" => Ok(SessionStatus::Running),
        "waiting_approval" => Ok(SessionStatus::WaitingApproval),
        "cancelling" => Ok(SessionStatus::Cancelling),
        "failed" => Ok(SessionStatus::Failed),
        other => Err(invalid_text(format!("session status {other}"))),
    }
}

fn parse_role(value: &str) -> rusqlite::Result<Role> {
    match value {
        "user" => Ok(Role::User),
        "assistant" => Ok(Role::Assistant),
        "system" => Ok(Role::System),
        "tool" => Ok(Role::Tool),
        other => Err(invalid_text(format!("role {other}"))),
    }
}

fn parse_tool_call_status(value: &str) -> rusqlite::Result<ToolCallStatus> {
    match value {
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

fn parse_risk_level(value: &str) -> rusqlite::Result<RiskLevel> {
    match value {
        "low" => Ok(RiskLevel::Low),
        "medium" => Ok(RiskLevel::Medium),
        "high" => Ok(RiskLevel::High),
        "blocked" => Ok(RiskLevel::Blocked),
        other => Err(invalid_text(format!("risk level {other}"))),
    }
}

fn parse_approval_status(value: &str) -> rusqlite::Result<ApprovalStatus> {
    match value {
        "pending" => Ok(ApprovalStatus::Pending),
        "approved" => Ok(ApprovalStatus::Approved),
        "approved_for_session" => Ok(ApprovalStatus::ApprovedForSession),
        "rejected" => Ok(ApprovalStatus::Rejected),
        other => Err(invalid_text(format!("approval status {other}"))),
    }
}

fn invalid_text(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn parse_json(value: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

pub(super) fn row_to_scheduled_task(row: &Row<'_>) -> rusqlite::Result<ScheduledTask> {
    let schedule_raw: String = row.get(4)?;
    Ok(ScheduledTask {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        prompt: row.get(3)?,
        schedule: serde_json::from_str(&schedule_raw).unwrap_or(Value::Null),
        enabled: row.get(5)?,
        next_run_at: row.get(6)?,
        last_run_at: row.get(7)?,
        last_session_id: row.get(8)?,
        created_at: row.get(9)?,
    })
}

pub(super) fn row_to_workspace(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

pub(super) fn row_to_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    let status: String = row.get(3)?;
    let provider: Option<String> = row.get(6)?;
    Ok(Session {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        status: parse_session_status(&status)?,
        external: provider
            .map(|provider| external_session_link(row, &provider))
            .transpose()?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn external_session_link(row: &Row<'_>, provider: &str) -> rusqlite::Result<ExternalSessionLink> {
    let continuation: String = row.get(9)?;
    Ok(ExternalSessionLink {
        provider: parse_external_provider(provider)?,
        external_id: row.get(7)?,
        source_path: row.get(8)?,
        continuation_mode: parse_continuation_mode(&continuation)?,
        imported_at: row.get(10)?,
        last_synced_at: row.get(11)?,
    })
}

fn parse_external_provider(value: &str) -> rusqlite::Result<ExternalProvider> {
    match value {
        "codex" => Ok(ExternalProvider::Codex),
        "claude_code" => Ok(ExternalProvider::ClaudeCode),
        "opencode" => Ok(ExternalProvider::OpenCode),
        other => Err(invalid_text(format!("external provider {other}"))),
    }
}

fn parse_continuation_mode(value: &str) -> rusqlite::Result<ExternalContinuationMode> {
    match value {
        "native_resumable" => Ok(ExternalContinuationMode::NativeResumable),
        "recreate_only" => Ok(ExternalContinuationMode::RecreateOnly),
        "read_only" => Ok(ExternalContinuationMode::ReadOnly),
        other => Err(invalid_text(format!("external continuation mode {other}"))),
    }
}

pub(super) fn row_to_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    let role: String = row.get(2)?;
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: parse_role(&role)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
    })
}

pub(super) fn row_to_tool_call(row: &Row<'_>) -> rusqlite::Result<ToolCall> {
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

pub(super) fn row_to_approval(row: &Row<'_>) -> rusqlite::Result<Approval> {
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
