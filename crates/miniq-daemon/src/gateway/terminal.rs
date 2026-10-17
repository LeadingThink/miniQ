use super::common::{params, store_err};
use crate::state::AppState;
use miniq_protocol::{ErrorCode, RpcError};
use miniq_tools::{TerminalLaunch, TerminalOutputRequest};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};

const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    session_id: String,
    #[serde(default = "default_rows")]
    rows: u16,
    #[serde(default = "default_cols")]
    cols: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdInput {
    session_id: String,
    terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    session_id: String,
    terminal_id: String,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    wait_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputInput {
    session_id: String,
    terminal_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResizeInput {
    session_id: String,
    terminal_id: String,
    rows: u16,
    cols: u16,
}

fn default_rows() -> u16 {
    24
}

fn default_cols() -> u16 {
    80
}

fn terminal_error(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, error.to_string())
}

fn cwd(state: &AppState, session_id: &str) -> Result<PathBuf, RpcError> {
    let session = state.store.get_session(session_id).map_err(store_err)?;
    let path = PathBuf::from(session.working_directory);
    if !path.is_dir() {
        return Err(terminal_error("session working directory is unavailable"));
    }
    Ok(path)
}

fn validate_size(rows: u16, cols: u16) -> Result<(), RpcError> {
    if !(1..=1000).contains(&rows) || !(1..=1000).contains(&cols) {
        return Err(terminal_error("rows and cols must be between 1 and 1000"));
    }
    Ok(())
}

pub(super) async fn create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CreateInput = params(raw)?;
    validate_size(input.rows, input.cols)?;
    let cwd = cwd(state, &input.session_id)?;
    let id = state
        .processes
        .terminal_start(
            &input.session_id,
            TerminalLaunch {
                command: default_shell_command(),
                cwd,
                rows: input.rows,
                cols: input.cols,
            },
        )
        .await
        .map_err(terminal_error)?;
    Ok(json!({"terminalId": id}))
}

pub(super) async fn read(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ReadInput = params(raw)?;
    if input.wait_ms > 30_000 {
        return Err(terminal_error("waitMs must not exceed 30000"));
    }
    let cwd = cwd(state, &input.session_id)?;
    state
        .processes
        .terminal_output(
            &input.session_id,
            cwd,
            &input.terminal_id,
            TerminalOutputRequest {
                stdout_offset: input.offset,
                max_bytes: MAX_OUTPUT_BYTES,
                wait: Duration::from_millis(input.wait_ms),
            },
        )
        .await
        .map_err(terminal_error)
}

pub(super) async fn input(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: InputInput = params(raw)?;
    if input.data.len() > 64 * 1024 {
        return Err(terminal_error("terminal input exceeds 64 KiB"));
    }
    let cwd = cwd(state, &input.session_id)?;
    state
        .processes
        .terminal_input(&input.session_id, cwd, &input.terminal_id, input.data)
        .await
        .map_err(terminal_error)?;
    Ok(json!({"ok": true}))
}

pub(super) async fn resize(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ResizeInput = params(raw)?;
    validate_size(input.rows, input.cols)?;
    let cwd = cwd(state, &input.session_id)?;
    state
        .processes
        .terminal_resize(
            &input.session_id,
            cwd,
            &input.terminal_id,
            input.rows,
            input.cols,
        )
        .await
        .map_err(terminal_error)
}

pub(super) async fn close(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: IdInput = params(raw)?;
    let cwd = cwd(state, &input.session_id)?;
    state
        .processes
        .terminal_close(&input.session_id, cwd, &input.terminal_id)
        .await
        .map_err(terminal_error)
}

#[cfg(unix)]
fn default_shell_command() -> String {
    "exec \"${SHELL:-/bin/sh}\" -l".into()
}

#[cfg(windows)]
fn default_shell_command() -> String {
    "powershell.exe -NoLogo".into()
}
