//! Turn-scoped file changes: group a turn's checkpoints per file and revert
//! every file the turn changed back to its content at turn start.

use std::collections::HashMap;
use std::path::Path;

use miniq_memory::CheckpointRow;
use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use super::session_diff::{checkpoint_contents, current_contents, workspace_relative_path};
use crate::executor::checkpoint::content_state;
use crate::state::AppState;

/// First and last checkpoint of one file inside a turn. The first backup is
/// the turn baseline; the last one's `after_state` is the turn-end state.
pub(super) struct FileSpan<'a> {
    pub first: &'a CheckpointRow,
    pub last: &'a CheckpointRow,
}

/// Per-file spans in first-edited order.
pub(super) fn file_spans(checkpoints: &[CheckpointRow]) -> Vec<FileSpan<'_>> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut spans: Vec<FileSpan<'_>> = Vec::new();
    for checkpoint in checkpoints {
        match index.get(checkpoint.abs_path.as_str()) {
            Some(&position) => spans[position].last = checkpoint,
            None => {
                index.insert(checkpoint.abs_path.as_str(), spans.len());
                spans.push(FileSpan {
                    first: checkpoint,
                    last: checkpoint,
                });
            }
        }
    }
    spans
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevertParams {
    session_id: String,
    /// User message that started the turn.
    turn_id: String,
    /// Restore even when files changed after the turn ended.
    #[serde(default)]
    force: bool,
}

struct RestorePlan {
    path: String,
    contents: Option<Vec<u8>>,
}

/// Restore every file the turn changed to its turn-start content. Files
/// edited after the turn ended block the revert unless `force` is set; all
/// files are validated and their baselines loaded before any write.
pub(super) fn revert(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: RevertParams = params(raw)?;
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    if state.begin_turn(&input.session_id).is_none() {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session already has an active turn",
        ));
    }
    let result = revert_locked(state, &session.working_directory, &input);
    state.end_turn(&input.session_id);
    result
}

fn revert_locked(
    state: &AppState,
    workspace_path: &str,
    input: &RevertParams,
) -> Result<Value, RpcError> {
    let turn = state
        .store
        .turn_checkpoints(&input.session_id, &input.turn_id)
        .map_err(store_err)?;
    let mut modified = Vec::new();
    let mut plans = Vec::new();
    for span in file_spans(&turn.within) {
        let path = &span.first.abs_path;
        let baseline = checkpoint_contents(span.first)?;
        let current = current_contents(path)?;
        if current == baseline {
            continue;
        }
        let current_state = current
            .as_deref()
            .map_or_else(|| "absent".to_string(), content_state);
        let reason = match span.last.after_state.as_deref() {
            None => Some("unverified"),
            Some(expected) if expected != current_state => Some("modified"),
            Some(_) => None,
        };
        if let Some(reason) = reason {
            modified.push(json!({
                "path": workspace_relative_path(workspace_path, Path::new(path)),
                "absolutePath": path,
                "reason": reason,
            }));
        }
        plans.push(RestorePlan {
            path: path.clone(),
            contents: baseline,
        });
    }
    if !modified.is_empty() && !input.force {
        return to_value(json!({ "reverted": false, "modifiedFiles": modified }));
    }
    let mut restored = Vec::new();
    let mut failed = Vec::new();
    for plan in plans {
        match restore(&plan) {
            Ok(()) => restored.push(plan.path),
            Err(error) => failed.push(json!({ "path": plan.path, "error": error.to_string() })),
        }
    }
    let _ = state.store.append_audit_event(
        Some(&input.session_id),
        "turn_revert",
        &json!({
            "turnId": input.turn_id,
            "restoredFiles": restored.len(),
            "failedFiles": failed.len(),
            "forced": !modified.is_empty(),
        }),
    );
    to_value(json!({
        "reverted": true,
        "restoredFiles": restored,
        "failedFiles": failed,
        "forced": !modified.is_empty(),
    }))
}

fn restore(plan: &RestorePlan) -> std::io::Result<()> {
    let target = Path::new(&plan.path);
    match &plan.contents {
        Some(bytes) => {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(target, bytes)
        }
        None => match std::fs::remove_file(target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        },
    }
}

#[cfg(test)]
#[path = "session_turns_tests.rs"]
mod tests;
