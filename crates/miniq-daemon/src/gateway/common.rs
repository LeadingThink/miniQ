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

pub(super) fn to_value<T: serde::Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))
}
