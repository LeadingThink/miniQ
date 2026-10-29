use miniq_memory::MemoryError;
use miniq_protocol::{
    ErrorCode, MemoryDeleteParams, MemoryListParams, MemorySettings, MemoryWriteParams, RpcError,
    SessionMemorySettings,
};
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

pub(super) fn write(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: MemoryWriteParams = params(raw)?;
    to_value(state.store.write_memory(&input, None).map_err(memory_err)?)
}
pub(super) fn settings(state: &AppState) -> Result<Value, RpcError> {
    to_value(state.store.memory_settings().map_err(memory_err)?)
}

pub(super) fn read(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: miniq_protocol::MemoryReadParams = params(raw)?;
    Ok(
        json!({"memory":state.store.memory_by_id(&input.target,&input.id).map_err(memory_err)?,
        "sources":state.store.memory_sources(&input.target,&input.id).map_err(memory_err)?}),
    )
}
pub(super) fn configure(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: MemorySettings = params(raw)?;
    state
        .store
        .update_memory_settings(&input)
        .map_err(memory_err)?;
    to_value(input)
}
pub(super) fn session_configure(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionMemorySettings = params(raw)?;
    state
        .store
        .update_session_memory_settings(&input)
        .map_err(memory_err)?;
    to_value(input)
}
