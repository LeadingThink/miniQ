//! Accepted attachments own durable bytes, independent of source cleanup.

use std::io::Write;
use std::path::{Path, PathBuf};

use miniq_protocol::{ErrorCode, MessageAttachment, RpcError};

/// Upper bound for copying one non-image attachment. Larger files keep their
/// original path instead of being duplicated into the attachment store.
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;

/// Roll back new snapshots unless their message or queue record was persisted.
pub(super) struct PreparedAttachments {
    items: Vec<MessageAttachment>,
    snapshots: Vec<PathBuf>,
}

impl PreparedAttachments {
    pub(super) fn items(&self) -> &[MessageAttachment] {
        &self.items
    }

    pub(super) fn commit(mut self) {
        self.snapshots.clear();
    }
}

impl Drop for PreparedAttachments {
    fn drop(&mut self) {
        for path in &self.snapshots {
            remove_snapshot(path);
        }
    }
}

/// Stores every attachment the user handed over. Images always own durable
/// bytes because they are read as prompt input; any other file does too when
/// it comes from outside the workspace, where nothing guarantees it survives
/// until the model opens it.
pub(super) fn prepare(
    paths: &[String],
    storage: &Path,
    workspace_roots: &[PathBuf],
) -> Result<PreparedAttachments, RpcError> {
    let mut prepared = PreparedAttachments {
        items: Vec::with_capacity(paths.len()),
        snapshots: Vec::new(),
    };
    for source in paths {
        let canonical = dunce::canonicalize(source).map_err(|error| {
            RpcError::new(
                ErrorCode::InvalidParams,
                format!("无法读取附件 {source}: {error}"),
            )
        })?;
        if !canonical
            .metadata()
            .is_ok_and(|metadata| metadata.is_file())
        {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                format!("附件不是可读取的文件: {}", canonical.display()),
            ));
        }
        let filename = canonical.file_name().unwrap_or_default();
        let name = filename.to_string_lossy().into_owned();
        let mime_type = image_mime_type(&canonical);
        let keeps_original = mime_type.is_none() && inside_workspace(&canonical, workspace_roots);
        let path = if keeps_original || is_managed_snapshot(&canonical, storage) {
            canonical
        } else {
            match read_snapshot_bytes(&canonical, mime_type.is_some(), source)? {
                Some(bytes) => {
                    let snapshot = save_snapshot(storage, filename, &bytes)?;
                    prepared.snapshots.push(snapshot.clone());
                    snapshot
                }
                // Too large to duplicate: the recorded path is all we have.
                None => canonical,
            }
        };
        prepared.items.push(MessageAttachment {
            path: path.to_string_lossy().into_owned(),
            name,
            mime_type: mime_type.map(str::to_owned),
        });
    }
    Ok(prepared)
}

/// Bytes for a durable copy, or `None` when a non-image file is too large.
fn read_snapshot_bytes(
    path: &Path,
    is_image: bool,
    source: &str,
) -> Result<Option<Vec<u8>>, RpcError> {
    if is_image {
        return miniq_models::read_image_bytes(path)
            .map(Some)
            .map_err(|error| {
                RpcError::new(
                    ErrorCode::InvalidParams,
                    format!("无法保存图片附件 {source}: {error}"),
                )
            });
    }
    let metadata = path.metadata().map_err(|error| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("无法保存附件 {source}: {error}"),
        )
    })?;
    if metadata.len() > MAX_SNAPSHOT_BYTES {
        return Ok(None);
    }
    std::fs::read(path).map(Some).map_err(|error| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("无法保存附件 {source}: {error}"),
        )
    })
}

fn inside_workspace(path: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| dunce::canonicalize(root).is_ok_and(|root| path.starts_with(&root)))
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn is_managed_snapshot(path: &Path, storage: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(storage) = dunce::canonicalize(storage) else {
        return false;
    };
    parent.parent() == Some(storage.as_path())
        && parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok())
}

fn remove_snapshot(path: &Path) {
    let _ = std::fs::remove_file(path);
    if let Some(parent) = path.parent() {
        // Only this newly created snapshot's empty directory is ours to remove.
        let _ = std::fs::remove_dir(parent);
    }
}

fn save_snapshot(
    storage: &Path,
    filename: &std::ffi::OsStr,
    bytes: &[u8],
) -> Result<PathBuf, RpcError> {
    let failed = |error| {
        RpcError::new(
            ErrorCode::InternalError,
            format!("无法保存图片附件的持久副本: {error}"),
        )
    };
    let mut directory = std::fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(storage).map_err(failed)?;
    let snapshot_dir = dunce::canonicalize(storage)
        .map_err(failed)?
        .join(uuid::Uuid::new_v4().to_string());
    directory
        .recursive(false)
        .create(&snapshot_dir)
        .map_err(failed)?;
    let path = snapshot_dir.join(filename);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| {
        let _ = std::fs::remove_dir(&snapshot_dir);
        failed(error)
    })?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        remove_snapshot(&path);
        return Err(failed(error));
    }
    Ok(path)
}

#[cfg(test)]
mod tests;
