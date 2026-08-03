use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    workspace_id: String,
    name: String,
    prompt: String,
    schedule: Value,
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
        )
        .map_err(store_err)?;
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

pub(super) fn run_now(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: IdParams = params(raw)?;
    let task = state
        .store
        .get_scheduled_task(&input.id)
        .map_err(store_err)?;
    let schedule = crate::schedule::parse_schedule(&task.schedule)
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))?;
    let session_id = crate::schedule::fire_task(state, &task)
        .map_err(|error| RpcError::new(ErrorCode::SessionBusy, error))?;
    let next_run = crate::schedule::next_run_iso(&schedule, time::OffsetDateTime::now_utc());
    let _ = state
        .store
        .mark_scheduled_task_run(&input.id, &session_id, &next_run);
    to_value(json!({ "sessionId": session_id }))
}
