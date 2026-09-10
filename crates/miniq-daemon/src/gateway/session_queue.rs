//! Pending-message operations. Editing never restarts or interrupts a turn.

use miniq_protocol::{ErrorCode, Event, RpcError, SessionStatus};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

pub(super) fn emit_queue_changed(state: &AppState, session_id: &str) {
    match state.store.list_queued_messages(session_id) {
        Ok(queue) => state.emit(Event::QueueChanged {
            session_id: session_id.to_string(),
            queue,
        }),
        Err(error) => tracing::error!(session_id, %error, "could not read pending queue"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueListParams {
    session_id: String,
}

pub(super) fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QueueListParams = params(raw)?;
    let queue = state
        .store
        .list_queued_messages(&input.session_id)
        .map_err(store_err)?;
    to_value(json!({ "queue": queue }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueItemParams {
    queued_message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueUpdateParams {
    session_id: String,
    queued_message_id: String,
    expected_content: String,
    content: String,
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QueueUpdateParams = params(raw)?;
    let updated = state
        .store
        .update_queued_message(
            &input.session_id,
            &input.queued_message_id,
            &input.expected_content,
            &input.content,
        )
        .map_err(|error| match &error {
            miniq_memory::MemoryError::NotFound(_) | miniq_memory::MemoryError::InvalidData(_) => {
                RpcError::new(ErrorCode::InvalidParams, error.to_string())
            }
            _ => store_err(error),
        })?;
    emit_queue_changed(state, &input.session_id);
    to_value(json!({ "updated": updated }))
}

pub(super) fn remove(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QueueItemParams = params(raw)?;
    let removed = state
        .store
        .remove_queued_message(&input.queued_message_id)
        .map_err(store_err)?;
    emit_queue_changed(state, &removed.session_id);
    to_value(json!({ "removed": removed }))
}

/// Promote a queued message and interrupt the running turn; turn-end drains it.
pub(super) fn steer(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QueueItemParams = params(raw)?;
    let promoted = state
        .store
        .promote_queued_message(&input.queued_message_id)
        .map_err(store_err)?;
    emit_queue_changed(state, &promoted.session_id);
    let interrupted = state.cancel_turn(&promoted.session_id);
    if interrupted {
        let _ = state
            .store
            .update_session_status(&promoted.session_id, SessionStatus::Cancelling);
        state.emit(Event::SessionStatusChanged {
            session_id: promoted.session_id.clone(),
            status: SessionStatus::Cancelling,
        });
    }
    to_value(json!({ "promoted": promoted, "interrupted": interrupted }))
}
