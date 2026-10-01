//! Append-only audit log for security-relevant operations (plan v3 §13.1).
//!
//! Entries are JSON lines in `<data_dir>/audit/audit.jsonl`. The file rotates
//! once it grows past [`MAX_BYTES`] so a chatty remote client cannot fill the disk.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::state::AppState;

const MAX_BYTES: u64 = 4 * 1024 * 1024;

pub fn audit_path(state: &AppState) -> Option<PathBuf> {
    let settings = state.settings_path.as_ref()?;
    Some(settings.parent()?.join("audit").join("audit.jsonl"))
}

/// Records one audit entry. Failures are logged but never block the operation.
pub fn record(state: &AppState, actor: &str, method: &str, detail: Value) {
    let entry = json!({
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default(),
        "actor": actor,
        "method": method,
        "detail": detail,
    });
    tracing::info!(target: "miniq::audit", "{entry}");
    if let Some(path) = audit_path(state) {
        if let Err(error) = append(&path, &entry) {
            tracing::warn!("failed to write audit log: {error}");
        }
    }
}

fn append(path: &Path, entry: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
        let _ = std::fs::rename(path, path.with_extension("jsonl.1"));
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let mut line = serde_json::to_vec(entry)?;
    line.push(b'\n');
    file.write_all(&line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_json_lines_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit").join("audit.jsonl");
        append(&path, &json!({"a": 1})).unwrap();
        append(&path, &json!({"a": 2})).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 2);
        std::fs::write(&path, vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();
        append(&path, &json!({"a": 3})).unwrap();
        assert!(path.with_extension("jsonl.1").exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
    }
}
