use std::collections::HashSet;
use std::path::Path;

use miniq_memory::CheckpointRow;
use miniq_protocol::{
    DiffHunk, DiffLine, DiffLineKind, ErrorCode, FileDiff, RpcError, Session, SessionDiff,
};
use serde::Deserialize;
use serde_json::Value;
use similar::{ChangeTag, TextDiff};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum DiffScope {
    #[default]
    Session,
    Turn,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffParams {
    session_id: String,
    #[serde(default)]
    scope: DiffScope,
    /// User message that started the turn; required for `scope: "turn"`.
    #[serde(default)]
    turn_id: Option<String>,
}

pub(super) fn get(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DiffParams = params(raw)?;
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let files = match (input.scope, input.turn_id) {
        (DiffScope::Session, _) => session_files(state, &session)?,
        (DiffScope::Turn, Some(turn_id)) => turn_files(state, &session, &turn_id)?,
        (DiffScope::Turn, None) => {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "turnId is required when scope is \"turn\"",
            ))
        }
    };
    let additions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();
    to_value(SessionDiff {
        files,
        additions,
        deletions,
    })
}

/// Every file the session changed: first checkpoint against the disk.
fn session_files(state: &AppState, session: &Session) -> Result<Vec<FileDiff>, RpcError> {
    let checkpoints = state
        .store
        .list_checkpoints(&session.id)
        .map_err(store_err)?;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for checkpoint in checkpoints {
        if seen.insert(checkpoint.abs_path.clone()) {
            let old = checkpoint_contents(&checkpoint)?;
            let new = current_contents(&checkpoint.abs_path)?;
            files.extend(diff_file(
                &session.working_directory,
                &checkpoint.abs_path,
                old,
                new,
            ));
        }
    }
    Ok(files)
}

/// Files one turn changed: content at turn start against content at turn
/// end. The end state is the backup taken by the next later write to the
/// file, or the disk when no later turn touched it.
fn turn_files(
    state: &AppState,
    session: &Session,
    turn_id: &str,
) -> Result<Vec<FileDiff>, RpcError> {
    let turn = state
        .store
        .turn_checkpoints(&session.id, turn_id)
        .map_err(store_err)?;
    let mut files = Vec::new();
    for span in super::session_turns::file_spans(&turn.within) {
        let path = &span.first.abs_path;
        let old = checkpoint_contents(span.first)?;
        let new = match turn.after.iter().find(|later| &later.abs_path == path) {
            Some(later) => checkpoint_contents(later)?,
            None => current_contents(path)?,
        };
        files.extend(diff_file(&session.working_directory, path, old, new));
    }
    Ok(files)
}

fn diff_file(
    workspace_path: &str,
    absolute_path: &str,
    old: Option<Vec<u8>>,
    new: Option<Vec<u8>>,
) -> Option<FileDiff> {
    if old == new {
        return None;
    }
    let path = workspace_relative_path(workspace_path, Path::new(absolute_path));
    let (binary, additions, deletions, hunks) = match (
        old.as_deref().map(std::str::from_utf8).transpose(),
        new.as_deref().map(std::str::from_utf8).transpose(),
    ) {
        (Ok(old_text), Ok(new_text)) => {
            let (additions, deletions, hunks) =
                build_text_diff(old_text.unwrap_or(""), new_text.unwrap_or(""));
            (false, additions, deletions, hunks)
        }
        _ => (true, 0, 0, Vec::new()),
    };
    Some(FileDiff {
        path,
        absolute_path: absolute_path.to_string(),
        old_exists: old.is_some(),
        new_exists: new.is_some(),
        binary,
        additions,
        deletions,
        hunks,
    })
}

/// File content before the checkpointed write; `None` when it did not exist.
pub(super) fn checkpoint_contents(checkpoint: &CheckpointRow) -> Result<Option<Vec<u8>>, RpcError> {
    if !checkpoint.existed {
        return Ok(None);
    }
    let backup = checkpoint.backup_path.as_deref().ok_or_else(|| {
        RpcError::new(
            ErrorCode::InternalError,
            format!("checkpoint {} has no backup", checkpoint.id),
        )
    })?;
    std::fs::read(backup).map(Some).map_err(io_error)
}

/// Current disk content; `None` when the file does not exist.
pub(super) fn current_contents(path: &str) -> Result<Option<Vec<u8>>, RpcError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

pub(super) fn workspace_relative_path(workspace_path: &str, absolute_path: &Path) -> String {
    absolute_path
        .strip_prefix(Path::new(workspace_path))
        .unwrap_or(absolute_path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn build_text_diff(old: &str, new: &str) -> (usize, usize, Vec<DiffHunk>) {
    let diff = TextDiff::from_lines(old, new);
    let mut additions = 0;
    let mut deletions = 0;
    let mut hunks = Vec::new();
    for group in diff.grouped_ops(3) {
        let old_range = group_range(&group, |op| op.old_range());
        let new_range = group_range(&group, |op| op.new_range());
        let mut lines = Vec::new();
        for op in group {
            for change in diff.iter_changes(&op) {
                let kind = match change.tag() {
                    ChangeTag::Equal => DiffLineKind::Context,
                    ChangeTag::Insert => {
                        additions += 1;
                        DiffLineKind::Addition
                    }
                    ChangeTag::Delete => {
                        deletions += 1;
                        DiffLineKind::Deletion
                    }
                };
                lines.push(DiffLine {
                    kind,
                    old_line: change.old_index().map(|index| index + 1),
                    new_line: change.new_index().map(|index| index + 1),
                    content: change.value().trim_end_matches(['\r', '\n']).to_string(),
                });
            }
        }
        hunks.push(DiffHunk {
            old_start: range_start(&old_range),
            old_lines: old_range.len(),
            new_start: range_start(&new_range),
            new_lines: new_range.len(),
            lines,
        });
    }
    (additions, deletions, hunks)
}

fn group_range(
    group: &[similar::DiffOp],
    range: impl Fn(&similar::DiffOp) -> std::ops::Range<usize>,
) -> std::ops::Range<usize> {
    let start = range(group.first().expect("diff group is non-empty")).start;
    let end = range(group.last().expect("diff group is non-empty")).end;
    start..end
}

fn range_start(range: &std::ops::Range<usize>) -> usize {
    if range.is_empty() {
        range.start
    } else {
        range.start + 1
    }
}

fn io_error(error: std::io::Error) -> RpcError {
    RpcError::new(ErrorCode::InternalError, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn builds_structured_line_diff_and_stats() {
        let (additions, deletions, hunks) =
            build_text_diff("one\ntwo\nthree\n", "one\nchanged\nthree\nfour\n");

        assert_eq!((additions, deletions), (2, 1));
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == DiffLineKind::Addition && line.content == "changed"));
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == DiffLineKind::Deletion && line.content == "two"));
    }

    #[test]
    fn compares_checkpoint_backup_with_current_file() {
        let workspace = tempfile::tempdir().unwrap();
        let target = workspace.path().join("src.txt");
        let backup = workspace.path().join("backup.txt");
        fs::write(&backup, "before\n").unwrap();
        fs::write(&target, "after\n").unwrap();
        let checkpoint = CheckpointRow {
            id: "checkpoint".into(),
            session_id: "session".into(),
            tool_call_id: "tool".into(),
            abs_path: target.to_string_lossy().into_owned(),
            existed: true,
            backup_path: Some(backup.to_string_lossy().into_owned()),
            created_at: "2026-08-03T00:00:00Z".into(),
            after_state: None,
        };

        let diff = diff_file(
            workspace.path().to_str().unwrap(),
            &checkpoint.abs_path,
            checkpoint_contents(&checkpoint).unwrap(),
            current_contents(&checkpoint.abs_path).unwrap(),
        )
        .unwrap();

        assert_eq!(diff.path, "src.txt");
        assert_eq!((diff.additions, diff.deletions), (1, 1));
        assert!(diff.old_exists);
        assert!(diff.new_exists);
        assert!(!diff.binary);
    }
}
