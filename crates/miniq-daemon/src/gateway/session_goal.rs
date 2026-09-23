use miniq_protocol::{ErrorCode, RpcError, SessionGoalUpdate};
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetParams {
    session_id: String,
}

pub(super) fn get(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: GetParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    to_value(json!({ "goal": state.store.session_goal(&input.session_id).map_err(store_err)? }))
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionGoalUpdate = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    if input.goal.trim().chars().count() > 2000 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "goal must be at most 2000 characters",
        ));
    }
    let goal = state.store.update_session_goal(&input).map_err(store_err)?;
    state.emit(miniq_protocol::Event::SessionGoalChanged {
        session_id: input.session_id,
        goal: Some(goal.clone()),
    });
    to_value(goal)
}
