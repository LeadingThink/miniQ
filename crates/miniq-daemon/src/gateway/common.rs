use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::Value;

pub(super) fn params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    let value = params.unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| {
        RpcError::new(ErrorCode::InvalidParams, format!("invalid params: {error}"))
    })
}

pub(super) fn store_err(error: miniq_memory::MemoryError) -> RpcError {
    match &error {
        miniq_memory::MemoryError::NotFound(what) if what.starts_with("session") => {
            RpcError::new(ErrorCode::SessionNotFound, error.to_string())
        }
        miniq_memory::MemoryError::NotFound(what) if what.starts_with("workspace") => {
            RpcError::new(ErrorCode::WorkspaceNotFound, error.to_string())
        }
        _ => RpcError::new(ErrorCode::InternalError, error.to_string()),
    }
}

/// History requests the store rejects as malformed are the caller's invalid
/// parameters, not internal faults.
pub(super) fn history_err(error: miniq_memory::MemoryError) -> RpcError {
    match error {
        miniq_memory::MemoryError::InvalidData(message) => {
            RpcError::new(ErrorCode::InvalidParams, message)
        }
        other => store_err(other),
    }
}

pub(super) fn to_value<T: serde::Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))
}

/// History and file diffs can hold SQLite locks or perform large disk reads.
/// Bound them outside Tokio's network workers so health and cancel remain live.
pub(super) async fn blocking_read(
    state: &crate::state::AppState,
    raw: Option<Value>,
    handler: fn(&crate::state::AppState, Option<Value>) -> Result<Value, RpcError>,
) -> Result<Value, RpcError> {
    use std::sync::{Arc, OnceLock};
    static LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = LIMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| RpcError::new(ErrorCode::InternalError, "read executor unavailable"))?;
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        handler(&state, raw)
    })
    .await
    .map_err(|_| RpcError::new(ErrorCode::InternalError, "read executor failed"))?
}
