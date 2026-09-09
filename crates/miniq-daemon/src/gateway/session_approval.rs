use miniq_protocol::{Event, RpcError, SessionApprovalSettings, SessionApprovalUpdate};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionParams {
    session_id: String,
}

pub(super) fn get(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionParams = params(raw)?;
    let mode = state
        .store
        .session_approval_mode(&input.session_id)
        .map_err(store_err)?;
    to_value(SessionApprovalSettings {
        mode,
        effective: mode.unwrap_or_else(|| state.settings.lock().unwrap().approval_mode),
    })
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionApprovalUpdate = params(raw)?;
    let mut allowances = state.session_allowlist.lock().unwrap();
    state
        .store
        .set_session_approval_mode(&input.session_id, input.mode)
        .map_err(store_err)?;
    allowances.remove(&input.session_id);
    drop(allowances);
    state.emit(Event::SessionApprovalChanged {
        session_id: input.session_id.clone(),
        mode: input.mode,
    });
    get(state, Some(json!({"sessionId": input.session_id})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::ApprovalMode;

    #[test]
    fn permission_changes_are_scoped_and_old_grants_do_not_reappear() {
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace("/tmp/approval-scope", "test")
            .unwrap();
        let a = store.create_session(&workspace.id, "a").unwrap();
        let b = store.create_session(&workspace.id, "b").unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        state.allow_for_session(&a.id, "shell_run:echo");
        state.allow_for_session(&b.id, "shell_run:echo");
        update(&state, Some(json!({"sessionId":a.id,"mode":"alwaysAsk"}))).unwrap();
        assert_eq!(
            state.approval_mode_for_session(&a.id).unwrap(),
            ApprovalMode::AlwaysAsk
        );
        assert_eq!(
            state.approval_mode_for_session(&b.id).unwrap(),
            ApprovalMode::Auto
        );
        assert!(!state.is_allowed_for_session(&a.id, "shell_run:echo"));
        assert!(state.is_allowed_for_session(&b.id, "shell_run:echo"));
        state.settings.lock().unwrap().approval_mode = ApprovalMode::FullAccess;
        assert_eq!(
            state.approval_mode_for_session(&a.id).unwrap(),
            ApprovalMode::AlwaysAsk
        );
        update(&state, Some(json!({"sessionId":a.id,"mode":null}))).unwrap();
        assert_eq!(
            state.approval_mode_for_session(&a.id).unwrap(),
            ApprovalMode::FullAccess
        );
        assert!(update(&state, Some(json!({"sessionId":a.id,"mode":"unknown"}))).is_err());
        assert!(update(&state, Some(json!({"sessionId":"missing","mode":"auto"}))).is_err());
    }
}
