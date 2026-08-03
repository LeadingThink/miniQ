use std::path::Path;
use std::sync::Arc;

use miniq_memory::Store;
use miniq_protocol::{
    ErrorCode, ExternalImportError, ExternalProvider, ExternalScanError,
    ExternalSessionImportRequest, ExternalSessionImportResult, ExternalSessionScan,
    ExternalSessionSelection, ExternalSessionSnapshot, RpcError,
};
use miniq_session_connectors::{
    builtin_registry, ConnectorError, ConnectorRegistry, ConnectorScan,
};
use serde_json::Value;

use super::common::{params, store_err, to_value};
use super::external_workspace::resolve_implicit_workspace;
use crate::state::AppState;

pub(super) async fn scan() -> Result<Value, RpcError> {
    let scans = tokio::task::spawn_blocking(|| builtin_registry().scan_all())
        .await
        .map_err(join_error)?;
    to_value(scan_response(scans))
}

pub(super) async fn import(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let request: ExternalSessionImportRequest = params(raw)?;
    if request.sessions.is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "at least one external session must be selected",
        ));
    }
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || import_selected(store, request.sessions))
        .await
        .map_err(join_error)?;
    to_value(result)
}

fn scan_response(scans: Vec<ConnectorScan>) -> ExternalSessionScan {
    let mut providers = Vec::new();
    let mut sessions = Vec::new();
    let mut errors = Vec::new();
    for scan in scans {
        let provider = scan.status.provider;
        providers.push(scan.status);
        sessions.extend(scan.sessions);
        errors.extend(
            scan.errors
                .into_iter()
                .map(|error| external_scan_error(provider, error)),
        );
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    ExternalSessionScan {
        providers,
        sessions,
        errors,
    }
}

fn import_selected(
    store: Arc<Store>,
    selections: Vec<ExternalSessionSelection>,
) -> ExternalSessionImportResult {
    let registry = builtin_registry();
    let mut errors = Vec::new();
    let mut imported_session_ids = Vec::new();
    let mut imported_messages = 0;
    for selection in selections {
        match import_one(&store, &registry, &selection) {
            Ok((session_id, message_count)) => {
                imported_session_ids.push(session_id);
                imported_messages += message_count;
            }
            Err(message) => errors.push(ExternalImportError {
                provider: selection.provider,
                external_id: Some(selection.external_id),
                message,
            }),
        }
    }
    ExternalSessionImportResult {
        imported_session_ids,
        imported_messages,
        errors,
    }
}

fn import_one(
    store: &Store,
    registry: &ConnectorRegistry,
    selection: &ExternalSessionSelection,
) -> Result<(String, usize), String> {
    let snapshot = registry
        .load(
            selection.provider,
            &selection.external_id,
            &selection.source_path,
        )
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "external session was not found during import".to_owned())?;
    let workspace_id = resolve_workspace(store, selection, &snapshot)?;
    let outcome = store
        .import_external_session(&workspace_id, &snapshot)
        .map_err(|error| store_err(error).message)?;
    Ok((outcome.session.id, outcome.imported_messages))
}

fn resolve_workspace(
    store: &Store,
    selection: &ExternalSessionSelection,
    snapshot: &ExternalSessionSnapshot,
) -> Result<String, String> {
    if let Some(workspace_id) = selection.workspace_id.as_deref() {
        return store
            .get_workspace(workspace_id)
            .map(|workspace| workspace.id)
            .map_err(|error| error.to_string());
    }
    let cwd = snapshot.summary.cwd.as_deref().ok_or_else(|| {
        "external session has no project directory; select a miniQ project".to_owned()
    })?;
    let workspace_path = resolve_implicit_workspace(Path::new(cwd), selection.provider)?;
    let workspace_display = super::workspace_path_display(&workspace_path);
    let name = workspace_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| workspace_path.to_string_lossy().into_owned());
    store
        .create_workspace(&workspace_display, &name)
        .map(|workspace| workspace.id)
        .map_err(|error| error.to_string())
}

fn external_scan_error(provider: ExternalProvider, error: ConnectorError) -> ExternalScanError {
    let source_path = match &error {
        ConnectorError::Io { path, .. }
        | ConnectorError::JsonLine { path, .. }
        | ConnectorError::Sqlite { path, .. } => Some(path.to_string_lossy().into_owned()),
        ConnectorError::InvalidData(_) => None,
    };
    ExternalScanError {
        provider,
        source_path,
        message: error.to_string(),
    }
}

fn join_error(error: tokio::task::JoinError) -> RpcError {
    RpcError::new(
        ErrorCode::InternalError,
        format!("external session task failed: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::{ExternalContinuationMode, ExternalSessionSummary};

    fn selection(workspace_id: Option<String>) -> ExternalSessionSelection {
        ExternalSessionSelection {
            provider: ExternalProvider::Codex,
            external_id: "external".to_owned(),
            source_path: "source".to_owned(),
            workspace_id,
        }
    }

    fn snapshot(cwd: String) -> ExternalSessionSnapshot {
        ExternalSessionSnapshot {
            summary: ExternalSessionSummary {
                provider: ExternalProvider::Codex,
                external_id: "external".to_owned(),
                title: "External".to_owned(),
                cwd: Some(cwd),
                source_path: "source".to_owned(),
                message_count: 0,
                created_at: None,
                updated_at: None,
                continuation_mode: ExternalContinuationMode::RecreateOnly,
            },
            events: Vec::new(),
            messages: Vec::new(),
        }
    }

    #[test]
    fn explicit_workspace_ignores_external_cwd() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("selected", "selected").unwrap();
        let selection = selection(Some(workspace.id.clone()));
        let snapshot = snapshot("missing-directory".to_owned());

        let resolved = resolve_workspace(&store, &selection, &snapshot).unwrap();

        assert_eq!(resolved, workspace.id);
    }

    #[test]
    fn implicit_workspace_reuses_normalized_existing_path() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open_in_memory().unwrap();
        let normalized = super::super::canonical_workspace_path(temp.path()).unwrap();
        let workspace = store.create_workspace(&normalized, "existing").unwrap();
        let selection = selection(None);
        let snapshot = snapshot(temp.path().to_string_lossy().into_owned());

        let resolved = resolve_workspace(&store, &selection, &snapshot).unwrap();

        assert_eq!(resolved, workspace.id);
        assert_eq!(store.list_workspaces().unwrap().len(), 1);
    }
}
