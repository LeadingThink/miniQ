use std::path::PathBuf;

use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

/// Read and write the workspace instruction file.
///
/// Only the primary workspace directory is writable. Discovery may read
/// attached roots, but writing instructions into a directory the user did not
/// designate as the project primary would silently change another repository's
/// rules.
const WRITE_FILENAME: &str = crate::instructions::DEFAULT_FILENAME;
const MAX_PREVIEW_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceParams {
    workspace_id: String,
}

fn workspace_root(state: &AppState, workspace_id: &str) -> Result<PathBuf, RpcError> {
    let workspace = state
        .store
        .get_workspace(workspace_id)
        .map_err(store_err)?;
    Ok(PathBuf::from(workspace.path))
}

/// Report the effective instruction set for a workspace.
pub(super) fn get(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: WorkspaceParams = params(raw)?;
    let root = workspace_root(state, &input.workspace_id)?;
    let settings = state.settings.lock().unwrap().instructions.clone();
    let loaded = crate::instructions::load(&root, &settings);
    let files: Vec<Value> = loaded
        .files
        .iter()
        .map(|file| {
            json!({
                "path": file.path.to_string_lossy(),
                "bytes": file.original_bytes,
                "renderedBytes": file.bytes(),
                "truncated": file.truncated,
            })
        })
        .collect();
    let text = loaded.text();
    let preview = text.chars().take(MAX_PREVIEW_BYTES).collect::<String>();
    to_value(json!({
        "workspaceId": input.workspace_id,
        "workspacePath": root.to_string_lossy(),
        "settings": settings,
        "files": files,
        "totalBytes": text.len(),
        "preview": preview,
        "truncated": text.len() > preview.len(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateParams {
    workspace_id: String,
    content: String,
    #[serde(default)]
    force: bool,
}

/// Create or replace `<workspace>/AGENTS.md`.
pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: UpdateParams = params(raw)?;
    let root = workspace_root(state, &input.workspace_id)?;
    if input.content.len() > crate::instructions::DEFAULT_MAX_BYTES * 32 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "instruction file is too large",
        ));
    }
    let warnings = miniq_skills::scan_sensitive(&input.content);
    if !warnings.is_empty() && !input.force {
        let mut error = RpcError::new(
            ErrorCode::InvalidParams,
            "instructions contain possibly sensitive content; edit them or pass force=true",
        );
        error.data = Some(json!({ "warnings": warnings }));
        return Err(error);
    }
    let path = root.join(WRITE_FILENAME);
    let trimmed = input.content.trim_end();
    if trimmed.trim().is_empty() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| {
                RpcError::new(ErrorCode::InternalError, error.to_string())
            })?;
        }
    } else {
        miniq_local::write_private_bytes(&path, trimmed.as_bytes()).map_err(|error| {
            RpcError::new(ErrorCode::InternalError, error.to_string())
        })?;
    }
    let _ = state.store.append_audit_event(
        None,
        "instructions_saved",
        &json!({
            "workspaceId": input.workspace_id,
            "path": path.to_string_lossy(),
            "bytes": trimmed.len(),
        }),
    );
    to_value(json!({
        "workspaceId": input.workspace_id,
        "path": path.to_string_lossy(),
        "bytes": trimmed.len(),
        "removed": trimmed.trim().is_empty(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use miniq_models::{ChatDelta, CompletionRequest, ModelCapabilities, ModelProvider};

    struct NullProvider;

    #[async_trait::async_trait]
    impl ModelProvider for NullProvider {
        async fn stream_complete(
            &self,
            _request: CompletionRequest,
        ) -> Result<miniq_models::DeltaStream, miniq_models::ProviderError> {
            Ok(Box::pin(futures_util::stream::iter(Vec::<
                Result<ChatDelta, miniq_models::ProviderError>,
            >::new())))
        }
        async fn capabilities(&self) -> ModelCapabilities {
            ModelCapabilities::default()
        }
        fn describe(&self) -> String {
            "null".to_string()
        }
    }

    fn fixture() -> (AppState, String, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(
            miniq_memory::Store::open_in_memory().unwrap(),
            "token".into(),
            std::sync::Arc::new(NullProvider),
        );
        let workspace = state
            .store
            .create_workspace(&temp.path().to_string_lossy(), "ws")
            .unwrap();
        (state, workspace.id, temp)
    }

    #[test]
    fn write_then_read_round_trips_the_instructions() {
        let (state, workspace_id, temp) = fixture();
        update(
            &state,
            Some(json!({
                "workspaceId": workspace_id,
                "content": "Use pnpm, never npm.\n",
            })),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join(WRITE_FILENAME)).unwrap(),
            "Use pnpm, never npm."
        );
        let read = get(&state, Some(json!({ "workspaceId": workspace_id }))).unwrap();
        assert_eq!(read["files"].as_array().unwrap().len(), 1);
        assert!(read["preview"].as_str().unwrap().contains("Use pnpm"));
    }

    #[test]
    fn empty_content_removes_the_file() {
        let (state, workspace_id, temp) = fixture();
        update(
            &state,
            Some(json!({ "workspaceId": workspace_id, "content": "rule" })),
        )
        .unwrap();
        update(
            &state,
            Some(json!({ "workspaceId": workspace_id, "content": "   " })),
        )
        .unwrap();
        assert!(!temp.path().join(WRITE_FILENAME).exists());
    }

    #[test]
    fn sensitive_content_requires_force() {
        let (state, workspace_id, temp) = fixture();
        let result = update(
            &state,
            Some(json!({
                "workspaceId": workspace_id,
                "content": "api_key = \"sk-live-0123456789abcdef\"",
            })),
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams as i64);
        assert!(!temp.path().join(WRITE_FILENAME).exists());

        update(
            &state,
            Some(json!({
                "workspaceId": workspace_id,
                "content": "api_key = \"sk-live-0123456789abcdef\"",
                "force": true,
            })),
        )
        .unwrap();
        assert!(temp.path().join(WRITE_FILENAME).exists());
    }

    #[test]
    fn unknown_workspace_is_reported_as_missing() {
        let (state, _, _) = fixture();
        let error = get(&state, Some(json!({ "workspaceId": "ws_missing" }))).unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceNotFound as i64);
    }
}
