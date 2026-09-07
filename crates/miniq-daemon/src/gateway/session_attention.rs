use miniq_protocol::{Event, RpcError, SessionStatus};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcknowledgeFailureParams {
    session_id: String,
    updated_at: String,
}

pub(super) fn acknowledge_failure(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: AcknowledgeFailureParams = params(raw)?;
    // Serialize acknowledgement with turn admission, including the interval
    // before a newly admitted turn has persisted its running status.
    let turns = state.active_turns.lock().unwrap();
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let acknowledged = !turns.contains_key(&input.session_id)
        && state
            .store
            .acknowledge_session_failure(&input.session_id, &input.updated_at)
            .map_err(store_err)?;
    if acknowledged {
        state.emit(Event::SessionStatusChanged {
            session_id: input.session_id.clone(),
            status: SessionStatus::Idle,
        });
    }
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    to_value(json!({"acknowledged": acknowledged, "session": session}))
}

#[cfg(test)]
mod tests;
