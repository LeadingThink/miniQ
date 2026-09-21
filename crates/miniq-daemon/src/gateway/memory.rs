use miniq_memory::MemoryError;
use miniq_protocol::{ErrorCode, MemoryDeleteParams, MemoryListParams, RpcError};
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

pub(super) fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: MemoryListParams = params(raw)?;
    to_value(state.store.list_memories(&input).map_err(memory_err)?)
}

pub(super) fn delete(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: MemoryDeleteParams = params(raw)?;
    state.store.delete_memory(&input).map_err(memory_err)?;
    Ok(json!({ "deleted": input.id }))
}

fn memory_err(error: MemoryError) -> RpcError {
    match error {
        MemoryError::InvalidData(message) => RpcError::new(ErrorCode::InvalidParams, message),
        other => store_err(other),
    }
}
