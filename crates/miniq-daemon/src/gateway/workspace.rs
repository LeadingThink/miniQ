use std::path::Path;

use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    path: String,
    #[serde(default)]
    name: Option<String>,
}

pub(super) fn open(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: OpenParams = params(raw)?;
    let path = Path::new(&input.path);
    if !path.is_dir() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("workspace path is not a directory: {}", input.path),
        ));
    }

    let name = input.name.unwrap_or_else(|| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| input.path.clone())
    });
    let canonical = super::canonical_workspace_path(path).unwrap_or(input.path);
    let workspace = state
        .store
        .create_workspace(&canonical, &name)
        .map_err(store_err)?;
    to_value(workspace)
}

pub(super) fn list(state: &AppState) -> Result<Value, RpcError> {
    let workspaces = state.store.list_workspaces().map_err(store_err)?;
    to_value(json!({ "workspaces": workspaces }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    name: String,
}

/// Create a blank project in the daemon data directory.
pub(super) fn create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CreateParams = params(raw)?;
    let name = input.name.trim();
    validate_name(name)?;

    let directory = crate::data_dir().join("projects").join(name);
    std::fs::create_dir_all(&directory)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?;
    let canonical = super::canonical_workspace_path(&directory)
        .unwrap_or_else(|| directory.to_string_lossy().to_string());
    let workspace = state
        .store
        .create_workspace(&canonical, name)
        .map_err(store_err)?;
    to_value(workspace)
}

fn validate_name(name: &str) -> Result<(), RpcError> {
    if name.is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "project name is empty",
        ));
    }
    if name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "project name contains invalid characters",
        ));
    }
    Ok(())
}
