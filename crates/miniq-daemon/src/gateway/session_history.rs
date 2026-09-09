use miniq_protocol::{ErrorCode, HistoryParams, RpcError, ToolDetailParams};
use serde_json::Value;

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncParams {
    session_id: String,
    cursor: crate::event_journal::EventCursor,
}

pub(super) fn sync(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SyncParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let journal = state.event_journal.lock().unwrap();
    Ok(
        serde_json::json!({ "events": journal.replay(&input.session_id, &input.cursor), "eventCursor": journal.cursor() }),
    )
}

pub(super) fn page(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: HistoryParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    to_value(state.store.history_page(&input).map_err(store_err)?)
}

pub(super) fn model_calls(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: miniq_protocol::ModelCallsParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    to_value(state.store.model_calls_page(&input).map_err(store_err)?)
}

pub(super) fn execution_events(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: miniq_protocol::ExecutionEventsParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    to_value(
        state
            .store
            .execution_events_page(&input)
            .map_err(store_err)?,
    )
}

pub(super) fn tool_detail(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ToolDetailParams = params(raw)?;
    let call = state
        .store
        .get_tool_call(&input.tool_call_id)
        .map_err(store_err)?;
    if call.session_id != input.session_id {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "tool does not belong to this session",
        ));
    }
    to_value(call)
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_memory::Store;
    use miniq_models::mock::MockProvider;
    use miniq_protocol::ToolCallStatus;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn tool_details_require_matching_session_and_preserve_complete_output() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace("/tmp/history-rpc", "history")
            .unwrap();
        let session = store.create_session(&workspace.id, "history").unwrap();
        let call = store
            .create_tool_call(
                &session.id,
                "shell_run",
                &json!({"command":"inspect"}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        let output = json!({"stdout":"complete output".repeat(100_000)});
        store
            .finish_tool_call(&call.id, ToolCallStatus::Succeeded, Some(&output))
            .unwrap();
        let state = AppState::new(
            store,
            "test-only".into(),
            Arc::new(MockProvider::text("unused")),
        );
        let detail = tool_detail(
            &state,
            Some(json!({"sessionId":session.id,"toolCallId":call.id})),
        )
        .unwrap();
        assert_eq!(detail["output"], output);
        assert!(tool_detail(
            &state,
            Some(json!({"sessionId":"other","toolCallId":call.id}))
        )
        .is_err());
        assert!(page(&state, Some(json!({"sessionId":"missing"}))).is_err());
        assert!(model_calls(&state, Some(json!({"sessionId":"missing"}))).is_err());
        assert!(model_calls(&state, Some(json!({"sessionId":session.id,"limit":0}))).is_err());
        assert_eq!(
            model_calls(&state, Some(json!({"sessionId":session.id}))).unwrap()["calls"],
            json!([])
        );
    }
}
