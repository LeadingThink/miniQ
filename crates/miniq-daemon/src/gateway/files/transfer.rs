//! Streaming transfer endpoints. The protocol validates size/hash before finish.
use super::{revision, scope, validated_session_file, AppState};
use std::{
    fs::File,
    path::{Path, PathBuf},
};
use tokio::io::AsyncWriteExt;

mod anchored;
use anchored::Directory;
pub(super) fn open_source_file(path: &Path) -> std::io::Result<File> {
    anchored::open_file(path)
}

pub(crate) const MAX_TRANSFER_BYTES: u64 = 200 * 1024 * 1024;

pub(crate) async fn transfer_source(
    state: &AppState,
    session_id: &str,
    path: &str,
    expected_revision: &str,
) -> Result<(tokio::fs::File, u64), String> {
    let scope = scope(state, session_id).map_err(|e| e.message)?;
    let store = state.store.clone();
    let session_id = session_id.to_owned();
    let path = path.to_owned();
    let expected_revision = expected_revision.to_owned();
    let (file, size) = tokio::task::spawn_blocking(move || {
        let path = validated_session_file(&store, &scope, &session_id, &path)?;
        let file = anchored::open_file(&path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_TRANSFER_BYTES {
            return Err("transfer requires a regular file no larger than 200 MiB".into());
        }
        if revision(&metadata)? != expected_revision {
            return Err("file changed; describe it again before transferring".into());
        }
        Ok::<_, String>((file, metadata.len()))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok((tokio::fs::File::from_std(file), size))
}

/// Recheck the opened source after streaming, before reporting success.
pub(crate) async fn check_transfer_revision(
    file: &tokio::fs::File,
    expected: &str,
) -> Result<(), String> {
    if revision(&file.metadata().await.map_err(|e| e.to_string())?)? != expected {
        return Err("file changed during transfer".into());
    }
    Ok(())
}

pub(crate) async fn transfer_destination(
    state: &AppState,
    session_id: &str,
    name: &str,
) -> Result<Destination, String> {
    let scope = scope(state, session_id).map_err(|e| e.message)?;
    validate_name(name)?;
    let name = name.to_owned();
    tokio::task::spawn_blocking(move || Destination::create(Path::new(&scope.cwd), &name))
        .await
        .map_err(|e| e.to_string())?
}

fn validate_name(name: &str) -> Result<(), String> {
    // Apply Windows rules on every platform, including ADS and reserved names.
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if name.is_empty()
        || name.len() > 240
        || name == "."
        || name == ".."
        || name.eq_ignore_ascii_case(".partial")
        || name.ends_with(['.', ' '])
        || reserved
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
    {
        return Err("transfer name must be a plain file name".into());
    }
    Ok(())
}

pub(crate) struct Destination {
    pub file: tokio::fs::File,
    /// Final path; no entry exists here until finish succeeds.
    pub path: PathBuf,
    directory: Directory,
    name: String,
    finished: bool,
    // Declared last so the file and transfer-directory handles close first on Windows.
    cleanup: Cleanup,
}

impl Destination {
    fn create(cwd: &Path, name: &str) -> Result<Self, String> {
        let cwd = dunce::canonicalize(cwd).map_err(|e| e.to_string())?;
        let root = Directory::open(&cwd).map_err(|e| e.to_string())?;
        let inbox = root.child("inbox", true).map_err(|e| e.to_string())?;
        let directory_name = uuid::Uuid::new_v4().to_string();
        let directory = inbox
            .create_unique(&directory_name)
            .map_err(|e| e.to_string())?;
        let file = match directory.create_file(".partial") {
            Ok(file) => file,
            Err(error) => {
                let _ = inbox.remove_dir(&directory_name);
                return Err(error.to_string());
            }
        };
        Ok(Self {
            file: tokio::fs::File::from_std(file),
            path: cwd.join("inbox").join(&directory_name).join(name),
            directory,
            name: name.into(),
            finished: false,
            cleanup: Cleanup {
                inbox,
                directory_name,
                finished: false,
            },
        })
    }

    /// Call only after the protocol has validated the complete byte count and hash.
    /// Hard-link publication is atomic and fails if the destination already exists.
    pub(crate) async fn finish(mut self) -> Result<PathBuf, String> {
        self.file.flush().await.map_err(|e| e.to_string())?;
        self.file.sync_all().await.map_err(|e| e.to_string())?;
        if self.file.metadata().await.map_err(|e| e.to_string())?.len() > MAX_TRANSFER_BYTES {
            return Err("transfer exceeds 200 MiB".into());
        }
        self.directory.verify_path().map_err(|e| e.to_string())?;
        self.directory
            .publish(".partial", &self.name)
            .map_err(|e| e.to_string())?;
        self.finished = true;
        self.cleanup.finished = true;
        let _ = self.directory.remove_file(".partial");
        Ok(self.path.clone())
    }
}

impl Drop for Destination {
    fn drop(&mut self) {
        if !self.finished {
            // Unlink through pinned handles; never recursively delete a replaced path.
            let _ = self.directory.remove_file(".partial");
        }
    }
}

struct Cleanup {
    inbox: Directory,
    directory_name: String,
    finished: bool,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.inbox.remove_dir(&self.directory_name);
        }
    }
}

#[cfg(test)]
mod tests;
