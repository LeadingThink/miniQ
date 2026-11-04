//! Restore a real undone exchange without calling the model or rerunning tools.
use super::common::{params, store_err};
use crate::state::AppState;
use miniq_protocol::{ErrorCode, Event, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
pub(super) struct FileRecovery {
    path: PathBuf,
    before: Option<PathBuf>,
    after: Option<PathBuf>,
}

fn error(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalError, error.to_string())
}

fn snapshot(path: &Path, target: &Path) -> Result<Option<PathBuf>, RpcError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            std::fs::copy(path, target).map_err(error)?;
            Ok(Some(target.into()))
        }
        Ok(_) => Err(error(format!("{} is not a regular file", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(e)),
    }
}

pub(super) fn before_undo(
    state: &AppState,
    checkpoints: &[miniq_memory::CheckpointRow],
) -> Result<Vec<FileRecovery>, RpcError> {
    let mut files = Vec::new();
    if checkpoints.is_empty() {
        return Ok(files);
    }
    let directory = state.checkpoints_dir.join(miniq_memory::new_id("redo"));
    std::fs::create_dir_all(&directory).map_err(error)?;
    for checkpoint in checkpoints {
        let path = PathBuf::from(&checkpoint.abs_path);
        if files.iter().any(|file: &FileRecovery| file.path == path) {
            continue;
        }
        let before = snapshot(&path, &directory.join(format!("{}-before", files.len())))?;
        files.push(FileRecovery {
            path,
            before,
            after: Some(directory.join(format!("{}-after", files.len()))),
        });
    }
    Ok(files)
}

pub(super) fn after_undo(
    state: &AppState,
    session: &str,
    mut files: Vec<FileRecovery>,
) -> Result<(), RpcError> {
    for file in &mut files {
        file.after = snapshot(
            &file.path,
            file.after.as_deref().expect("reserved snapshot path"),
        )?;
    }
    state
        .store
        .finish_undo_files(session, &serde_json::to_value(files).map_err(error)?)
        .map_err(store_err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    session_id: String,
}

pub(super) fn redo(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: Params = params(raw)?;
    let session = &input.session_id;
    state.store.get_session(session).map_err(store_err)?;
    if state.begin_turn(session).is_none() {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session already has an active turn",
        ));
    }
    let result = redo_locked(state, session);
    state.end_turn(session);
    result
}

fn redo_locked(state: &AppState, session: &str) -> Result<Value, RpcError> {
    let (id, manifest) = state.store.redo_candidate(session).map_err(store_err)?;
    let files: Vec<FileRecovery> = if manifest.is_null() {
        vec![]
    } else {
        serde_json::from_value(manifest).map_err(error)?
    };
    for file in &files {
        if !same_file(&file.path, file.after.as_deref())? {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                format!(
                    "{} changed after undo; redo would overwrite it",
                    file.path.display()
                ),
            ));
        }
    }
    for (index, file) in files.iter().enumerate() {
        if let Err(failure) = restore(&file.path, file.before.as_deref()) {
            let rollback = rollback(&files[..=index]);
            return Err(error(format!("{}; {rollback}", failure.message)));
        }
    }
    if let Err(failure) = state.store.restore_redo(session, id) {
        return Err(error(format!("{failure}; {}", rollback(&files))));
    }
    state.emit(Event::SessionRestored {
        session_id: session.into(),
    });
    Ok(
        json!({"restored":true,"restoredFiles":files.iter().map(|file| &file.path).collect::<Vec<_>>()}),
    )
}

fn rollback(files: &[FileRecovery]) -> String {
    let failures: Vec<_> = files
        .iter()
        .rev()
        .filter_map(|file| restore(&file.path, file.after.as_deref()).err())
        .map(|e| e.message)
        .collect();
    if failures.is_empty() {
        "file changes rolled back".into()
    } else {
        format!("file rollback failures: {}", failures.join("; "))
    }
}

fn same_file(path: &Path, expected: Option<&Path>) -> Result<bool, RpcError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(expected.is_none()),
        Err(e) => return Err(error(e)),
    };
    if !metadata.is_file() {
        return Ok(false);
    }
    let Some(expected) = expected else {
        return Ok(false);
    };
    if metadata.len() != std::fs::metadata(expected).map_err(error)?.len() {
        return Ok(false);
    }
    let mut actual = BufReader::new(std::fs::File::open(path).map_err(error)?);
    let mut saved = BufReader::new(std::fs::File::open(expected).map_err(error)?);
    let (mut a, mut b) = ([0u8; 8192], [0u8; 8192]);
    loop {
        let count = actual.read(&mut a).map_err(error)?;
        if count == 0 {
            return Ok(true);
        }
        saved.read_exact(&mut b[..count]).map_err(error)?;
        if a[..count] != b[..count] {
            return Ok(false);
        }
    }
}

fn restore(path: &Path, source: Option<&Path>) -> Result<(), RpcError> {
    if let Some(source) = source {
        let mut temp = tempfile::NamedTempFile::new_in(
            path.parent().ok_or_else(|| error("file has no parent"))?,
        )
        .map_err(error)?;
        std::io::copy(&mut std::fs::File::open(source).map_err(error)?, &mut temp)
            .map_err(error)?;
        temp.as_file()
            .set_permissions(std::fs::metadata(source).map_err(error)?.permissions())
            .map_err(error)?;
        temp.persist(path).map_err(error)?;
    } else if path.exists() {
        std::fs::remove_file(path).map_err(error)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "session_redo_tests.rs"]
mod tests;
