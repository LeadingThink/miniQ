use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use miniq_memory::Store;
use miniq_protocol::{
    ErrorCode, ExternalImportError, ExternalProvider, ExternalScanError,
    ExternalSessionImportRequest, ExternalSessionImportStatusRequest, ExternalSessionScan,
    ExternalSessionSelection, ExternalSessionSnapshot, RpcError,
};
use miniq_session_connectors::{
    builtin_registry, ConnectorError, ConnectorRegistry, ConnectorScan,
};
use rayon::prelude::*;
use serde_json::Value;

use super::common::{params, store_err, to_value};
use super::external_workspace::resolve_implicit_workspace;
use crate::state::AppState;

const IMPORT_BATCH_SIZE: usize = 12;

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
    let job = state.external_import_jobs.start(request.sessions.len())?;
    let job_id = job.id.clone();
    let jobs = state.external_import_jobs.clone();
    let failure_jobs = jobs.clone();
    let failure_job_id = job_id.clone();
    let store = state.store.clone();
    let shutdown = state.shutdown.clone();
    let activity = state.activity.enter()?;
    tokio::spawn(async move {
        let worker = tokio::task::spawn_blocking(move || {
            let _activity = activity;
            import_selected(store, jobs, &job_id, request.sessions, shutdown);
        })
        .await;
        if let Err(error) = worker {
            failure_jobs.fail(
                &failure_job_id,
                format!("external session task failed: {error}"),
            );
        }
    });
    to_value(job)
}

pub(super) fn import_status(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let request: ExternalSessionImportStatusRequest = params(raw)?;
    if request.job_id.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "jobId must not be empty",
        ));
    }
    to_value(state.external_import_jobs.status(&request.job_id)?)
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
    jobs: Arc<crate::external_import_jobs::ExternalImportJobs>,
    job_id: &str,
    selections: Vec<ExternalSessionSelection>,
    shutdown: tokio_util::sync::CancellationToken,
) {
    let registry = builtin_registry();
    if let Err(error) = registry.prepare() {
        jobs.fail(job_id, error.to_string());
        return;
    }
    let mut workspaces = HashMap::new();
    for batch in selections.chunks(IMPORT_BATCH_SIZE) {
        if shutdown.is_cancelled() {
            jobs.fail(
                job_id,
                "external session import was cancelled during shutdown".to_owned(),
            );
            return;
        }
        let loaded: Vec<_> = batch
            .par_iter()
            .map(|selection| {
                let snapshot = if shutdown.is_cancelled() {
                    Err("external session import was cancelled during shutdown".to_owned())
                } else {
                    load_snapshot(&registry, selection)
                };
                (selection.clone(), snapshot)
            })
            .collect();
        if shutdown.is_cancelled() {
            jobs.fail(
                job_id,
                "external session import was cancelled during shutdown".to_owned(),
            );
            return;
        }
        let mut errors = Vec::new();
        let mut imports = Vec::new();
        for (selection, snapshot) in loaded {
            match snapshot {
                Ok(snapshot) => {
                    match resolve_workspace_cached(&store, &selection, &snapshot, &mut workspaces) {
                        Ok(workspace_id) => imports.push((workspace_id, snapshot)),
                        Err(message) => errors.push(import_error(&selection, message, true)),
                    }
                }
                Err(message) => errors.push(import_error(&selection, message, false)),
            }
        }
        let outcomes = match store.import_external_sessions(&imports) {
            Ok(outcomes) => outcomes,
            Err(error) => {
                jobs.fail(job_id, store_err(error).message);
                return;
            }
        };
        let imported = outcomes
            .into_iter()
            .map(|outcome| (outcome.session.id, outcome.imported_messages))
            .collect();
        jobs.record_batch(job_id, batch.len(), imported, errors);
    }
    jobs.complete(job_id);
}

fn load_snapshot(
    registry: &ConnectorRegistry,
    selection: &ExternalSessionSelection,
) -> Result<ExternalSessionSnapshot, String> {
    registry
        .load(
            selection.provider,
            &selection.external_id,
            &selection.source_path,
        )
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "external session was not found during import".to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum WorkspaceCacheKey {
    Explicit(String),
    Implicit(ExternalProvider, String),
}

fn resolve_workspace_cached(
    store: &Store,
    selection: &ExternalSessionSelection,
    snapshot: &ExternalSessionSnapshot,
    cache: &mut HashMap<WorkspaceCacheKey, Result<String, String>>,
) -> Result<String, String> {
    let key = match selection.workspace_id.as_ref() {
        Some(workspace_id) => WorkspaceCacheKey::Explicit(workspace_id.clone()),
        None => WorkspaceCacheKey::Implicit(
            selection.provider,
            snapshot.summary.cwd.clone().unwrap_or_default(),
        ),
    };
    if let Some(result) = cache.get(&key) {
        return result.clone();
    }
    let result = resolve_workspace(store, selection, snapshot);
    cache.insert(key, result.clone());
    result
}

fn import_error(
    selection: &ExternalSessionSelection,
    message: String,
    workspace_required: bool,
) -> ExternalImportError {
    ExternalImportError {
        provider: selection.provider,
        external_id: Some(selection.external_id.clone()),
        workspace_required,
        message,
    }
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
