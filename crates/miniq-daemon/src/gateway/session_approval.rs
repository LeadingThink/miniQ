use miniq_protocol::{
    ApprovalMode, Event, RpcError, SessionApprovalSettings, SessionApprovalUpdate,
};
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

fn rank(mode: ApprovalMode) -> u8 {
    match mode {
        ApprovalMode::AlwaysAsk => 0,
        ApprovalMode::Auto => 1,
        ApprovalMode::FullAccess => 2,
    }
}

fn effective(state: &AppState, mode: Option<ApprovalMode>) -> ApprovalMode {
    mode.unwrap_or_else(|| state.settings.lock().unwrap().approval_mode)
}

/// D16: remote clients may raise or lower a session's mode. Every remote change
/// is audited; raises carry `raised=true` so the desktop notifies the owner
/// and offers a one-click revert to `previous`.
pub(super) fn update(
    state: &AppState,
    raw: Option<Value>,
    actor: Option<&str>,
) -> Result<Value, RpcError> {
    let input: SessionApprovalUpdate = params(raw)?;
    let before = state
        .store
        .session_approval_mode(&input.session_id)
        .map_err(store_err)?;
    let previous = effective(state, before);
    let next = effective(state, input.mode);
    let raised = rank(next) > rank(previous);
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
        actor: actor.map(str::to_owned),
        previous: Some(previous),
        raised,
    });
    if let Some(actor) = actor {
        crate::audit::record(
            state,
            actor,
            "session.approval.update",
            json!({
                "sessionId": input.session_id,
                "previous": previous,
                "mode": input.mode,
                "effective": next,
                "raised": raised,
            }),
        );
    }
    get(state, Some(json!({"sessionId": input.session_id})))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        update(
            &state,
            Some(json!({"sessionId":a.id,"mode":"alwaysAsk"})),
            None,
        )
        .unwrap();
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
        update(&state, Some(json!({"sessionId":a.id,"mode":null})), None).unwrap();
        assert_eq!(
            state.approval_mode_for_session(&a.id).unwrap(),
            ApprovalMode::FullAccess
        );
        assert!(update(
            &state,
            Some(json!({"sessionId":a.id,"mode":"unknown"})),
            None
        )
        .is_err());
        assert!(update(
            &state,
            Some(json!({"sessionId":"missing","mode":"auto"})),
            None
        )
        .is_err());
    }

    #[test]
    fn remote_raise_is_allowed_scoped_and_flagged() {
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace("/tmp/approval-remote", "test")
            .unwrap();
        let a = store.create_session(&workspace.id, "a").unwrap();
        let b = store.create_session(&workspace.id, "b").unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        let mut events = state.events.subscribe();
        update(
            &state,
            Some(json!({"sessionId":a.id,"mode":"fullAccess"})),
            Some("remote:phone"),
        )
        .unwrap();
        assert_eq!(
            state.approval_mode_for_session(&a.id).unwrap(),
            ApprovalMode::FullAccess
        );
        assert_eq!(
            state.approval_mode_for_session(&b.id).unwrap(),
            ApprovalMode::Auto
        );
        let event = loop {
            let value = serde_json::to_value(events.try_recv().unwrap()).unwrap();
            if value["type"] == "session_approval_changed" {
                break value;
            }
        };
        assert_eq!(event["raised"], true);
        assert_eq!(event["actor"], "remote:phone");
        assert_eq!(event["previous"], "auto");
        update(
            &state,
            Some(json!({"sessionId":a.id,"mode":"alwaysAsk"})),
            Some("remote:phone"),
        )
        .unwrap();
        let event = loop {
            let value = serde_json::to_value(events.try_recv().unwrap()).unwrap();
            if value["type"] == "session_approval_changed" {
                break value;
            }
        };
        assert!(event.get("raised").is_none());
        assert!(update(
            &state,
            Some(json!({"sessionId":a.id,"mode":"root"})),
            Some("remote:phone"),
        )
        .is_err());
    }
}
