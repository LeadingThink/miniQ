use std::path::Path;

use miniq_protocol::{ErrorCode, Event, RpcError, WorkspaceRootsUpdate};
use serde_json::Value;

use super::common::{params, store_err, to_value};
use crate::state::AppState;

fn canonical_roots(paths: &[String]) -> Result<Vec<String>, RpcError> {
    let mut roots = Vec::new();
    for path in paths {
        let directory = Path::new(path);
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                format!("project directory must be an existing absolute path: {path}"),
            ));
        }
        let canonical = super::canonical_workspace_path(directory).ok_or_else(|| {
            RpcError::new(
                ErrorCode::InvalidParams,
                format!("cannot resolve directory: {path}"),
            )
        })?;
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    if roots.is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "project must have a primary directory",
        ));
    }
    Ok(roots)
}

pub(super) async fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: WorkspaceRootsUpdate = params(raw)?;
    let state = state.clone();
    tokio::task::spawn_blocking(move || update_locked(&state, input))
        .await
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?
}

fn update_locked(state: &AppState, input: WorkspaceRootsUpdate) -> Result<Value, RpcError> {
    let roots = canonical_roots(&input.paths)?;
    // Keep turn admission closed while checking child tasks and committing roots.
    // Waiting on their async mutexes belongs on this blocking worker, not the reactor.
    let active = state.active_turns.lock().unwrap();
    let sessions = state
        .store
        .list_sessions(Some(&input.workspace_id))
        .map_err(store_err)?;
    if sessions
        .iter()
        .any(|session| active.contains_key(&session.id))
    {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "project has active sessions",
        ));
    }
    for session in &sessions {
        if tokio::runtime::Handle::current().block_on(state.agent_tasks.has_active(&session.id)) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "project has active child agents",
            ));
        }
    }
    state
        .store
        .update_workspace_roots(&input.workspace_id, &roots[0], &roots[1..])
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error.to_string()))?;
    let workspace = state
        .store
        .get_workspace(&input.workspace_id)
        .map_err(store_err)?;
    drop(active);
    state.emit(Event::WorkspaceUpdated {
        workspace: workspace.clone(),
    });
    to_value(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_deduplicates_canonical_roots() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_str().unwrap().to_string();
        assert_eq!(
            canonical_roots(&[root.clone(), format!("{root}/.")])
                .unwrap()
                .len(),
            1
        );
        assert!(canonical_roots(&[]).is_err());
        assert!(canonical_roots(&["relative".into()]).is_err());
        assert!(canonical_roots(&[format!("{root}/missing")]).is_err());
        std::fs::write(directory.path().join("file"), "data").unwrap();
        assert!(canonical_roots(&[format!("{root}/file")]).is_err());
    }

    #[tokio::test]
    async fn updates_broadcast_roots_but_do_not_move_existing_sessions() {
        let primary = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let roots = canonical_roots(&[
            primary.path().display().to_string(),
            extra.path().display().to_string(),
        ])
        .unwrap();
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store.create_workspace(&roots[0], "project").unwrap();
        let session = store.create_session(&workspace.id, "existing").unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
        );
        let raw = Some(serde_json::json!({"workspaceId":workspace.id,"paths":[roots[1],roots[0]]}));
        state.begin_turn(&session.id).unwrap();
        assert!(update(&state, raw.clone()).await.is_err());
        state.end_turn(&session.id);
        let result = update(&state, raw).await.unwrap();
        assert_eq!(result["path"], roots[1]);
        assert_eq!(result["additionalPaths"], serde_json::json!([roots[0]]));
        assert_eq!(
            state
                .store
                .get_session(&session.id)
                .unwrap()
                .working_directory,
            roots[0]
        );
        let new = state.store.create_session(&workspace.id, "new").unwrap();
        assert_eq!(new.working_directory, roots[1]);
    }

    #[tokio::test]
    async fn active_child_blocks_changes_after_parent_turn_ends() {
        let primary = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let roots = canonical_roots(&[
            primary.path().display().to_string(),
            extra.path().display().to_string(),
        ])
        .unwrap();
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store.create_workspace(&roots[0], "project").unwrap();
        let session = store.create_session(&workspace.id, "parent").unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
        );
        let request = serde_json::from_value(serde_json::json!({
            "prompt": "background work", "runInBackground": true
        }))
        .unwrap();
        state.begin_turn(&session.id).unwrap();
        let (_, child) = state
            .agent_tasks
            .create(&session.id, None, &request, Default::default())
            .await
            .unwrap();
        state.end_turn(&session.id);
        let raw = Some(serde_json::json!({"workspaceId":workspace.id,"paths":roots}));
        let error = update(&state, raw.clone()).await.unwrap_err();
        assert!(error.message.contains("active child agents"));
        assert!(state
            .store
            .get_workspace(&workspace.id)
            .unwrap()
            .additional_paths
            .is_empty());
        state
            .agent_tasks
            .finish_error(&child, &miniq_agent::AgentError::Cancelled)
            .await;
        assert!(update(&state, raw).await.is_ok());
    }
}
