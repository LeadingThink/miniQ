use miniq_memory::MemoryError;
use miniq_protocol::{ErrorCode, RpcError, ScheduledTaskMode};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    workspace_id: String,
    name: String,
    prompt: String,
    schedule: Value,
    #[serde(default)]
    mode: ScheduledTaskMode,
    #[serde(default)]
    target_session_id: Option<String>,
    #[serde(default)]
    memory: String,
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, message)
}

fn schedule_err(error: MemoryError) -> RpcError {
    match error {
        MemoryError::InvalidData(message) => invalid(message),
        other => store_err(other),
    }
}

/// Validate the optional continuation target before persisting a task.  A
/// heartbeat is deliberately bound to one existing, local session and one
/// workspace; otherwise a typo would only surface when the scheduler fires.
fn validate_target(
    state: &AppState,
    workspace_id: &str,
    mode: ScheduledTaskMode,
    target_session_id: Option<&str>,
) -> Result<(), RpcError> {
    let target = target_session_id.map(str::trim).filter(|id| !id.is_empty());
    match mode {
        ScheduledTaskMode::NewSession => {
            if target.is_some() {
                return Err(invalid("targetSessionId is only valid for heartbeat tasks"));
            }
        }
        ScheduledTaskMode::Heartbeat => {
            let id = target.ok_or_else(|| invalid("heartbeat tasks require targetSessionId"))?;
            let session = state.store.get_session(id).map_err(|error| match error {
                MemoryError::NotFound(_) => invalid("目标会话不存在，请重新选择会话"),
                other => store_err(other),
            })?;
            if session.workspace_id != workspace_id {
                return Err(invalid(
                    "heartbeat target must belong to the selected project",
                ));
            }
            if session.archived || session.external.is_some() {
                return Err(invalid("heartbeat target must be an active local session"));
            }
        }
    }
    Ok(())
}

pub(super) fn create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CreateParams = params(raw)?;
    if input.name.trim().is_empty() || input.prompt.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "name and prompt must not be empty",
        ));
    }
    state
        .store
        .get_workspace(&input.workspace_id)
        .map_err(store_err)?;
    let target_session_id = input
        .target_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    validate_target(state, &input.workspace_id, input.mode, target_session_id)?;
    let schedule = crate::schedule::parse_schedule(&input.schedule)
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))?;
    let next_run = crate::schedule::next_run_iso(&schedule, time::OffsetDateTime::now_utc());
    let task = state
        .store
        .create_scheduled_task(
            &input.workspace_id,
            input.name.trim(),
            &input.prompt,
            &input.schedule,
            &next_run,
            input.mode,
            target_session_id,
            &input.memory,
        )
        .map_err(schedule_err)?;
    to_value(task)
}

pub(super) fn list(state: &AppState) -> Result<Value, RpcError> {
    let tasks = state.store.list_scheduled_tasks().map_err(store_err)?;
    to_value(json!({ "tasks": tasks }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToggleParams {
    id: String,
    enabled: bool,
}

pub(super) fn toggle(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ToggleParams = params(raw)?;
    let next_run = next_run_if_enabled(state, &input.id, input.enabled)?;
    state
        .store
        .set_scheduled_task_enabled(&input.id, input.enabled, next_run.as_deref())
        .map_err(store_err)?;
    let task = state
        .store
        .get_scheduled_task(&input.id)
        .map_err(store_err)?;
    to_value(task)
}

fn next_run_if_enabled(
    state: &AppState,
    task_id: &str,
    enabled: bool,
) -> Result<Option<String>, RpcError> {
    if !enabled {
        return Ok(None);
    }
    let task = state.store.get_scheduled_task(task_id).map_err(store_err)?;
    validate_target(
        state,
        &task.workspace_id,
        task.mode,
        task.target_session_id.as_deref(),
    )?;
    let schedule = crate::schedule::parse_schedule(&task.schedule)
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))?;
    Ok(Some(crate::schedule::next_run_iso(
        &schedule,
        time::OffsetDateTime::now_utc(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdParams {
    id: String,
}

pub(super) fn delete(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: IdParams = params(raw)?;
    state
        .store
        .delete_scheduled_task(&input.id)
        .map_err(store_err)?;
    to_value(json!({ "deleted": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateParams {
    id: String,
    #[serde(default)]
    workspace_id: Option<String>,
    name: String,
    prompt: String,
    schedule: Value,
    #[serde(default)]
    mode: ScheduledTaskMode,
    #[serde(default)]
    target_session_id: Option<String>,
    #[serde(default)]
    memory: String,
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: UpdateParams = params(raw)?;
    if input.name.trim().is_empty() || input.prompt.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "name and prompt must not be empty",
        ));
    }
    let existing = state
        .store
        .get_scheduled_task(&input.id)
        .map_err(store_err)?;
    let workspace_id = input
        .workspace_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or(&existing.workspace_id);
    let target_session_id = input
        .target_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    state.store.get_workspace(workspace_id).map_err(store_err)?;
    validate_target(state, workspace_id, input.mode, target_session_id)?;
    let parsed = crate::schedule::parse_schedule(&input.schedule)
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))?;
    let next = crate::schedule::next_run_iso(&parsed, time::OffsetDateTime::now_utc());
    let task = state
        .store
        .update_scheduled_task(
            &input.id,
            workspace_id,
            input.name.trim(),
            input.prompt.trim(),
            &input.schedule,
            input.mode,
            target_session_id,
            &input.memory,
            &next,
        )
        .map_err(schedule_err)?;
    to_value(task)
}

pub(super) fn run_now(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: IdParams = params(raw)?;
    let task = state
        .store
        .get_scheduled_task(&input.id)
        .map_err(store_err)?;
    let session_id = crate::schedule::fire_task(state, &task)
        .map_err(|error| RpcError::new(ErrorCode::SessionBusy, error))?;
    to_value(json!({ "sessionId": session_id }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunsParams {
    task_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default = "default_run_limit", deserialize_with = "run_limit")]
    limit: usize,
}

fn default_run_limit() -> usize {
    20
}

fn run_limit<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let limit = usize::deserialize(deserializer)?;
    if (1..=100).contains(&limit) {
        Ok(limit)
    } else {
        Err(serde::de::Error::custom("limit must be between 1 and 100"))
    }
}

pub(super) fn runs(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: RunsParams = params(raw)?;
    state
        .store
        .get_scheduled_task(&input.task_id)
        .map_err(store_err)?;
    let page = state
        .store
        .list_scheduled_task_runs(&input.task_id, input.cursor.as_deref(), input.limit)
        .map_err(store_err)?;
    to_value(json!({ "runs": page.runs, "nextCursor": page.next_cursor }))
}
