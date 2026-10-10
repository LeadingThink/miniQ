use miniq_memory::CheckpointRow;
use miniq_models::ToolCallRequest;
use sha2::{Digest, Sha256};

use super::SessionToolExecutor;

/// File state recorded on a checkpoint after its tool call finished:
/// `absent`, or `sha256:<hex>` of the content.
pub(crate) fn file_state(path: &std::path::Path) -> std::io::Result<String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(content_state(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("absent".into()),
        Err(error) => Err(error),
    }
}

pub(crate) fn content_state(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

impl SessionToolExecutor {
    pub(super) fn take_checkpoints(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
    ) -> Vec<CheckpointRow> {
        let paths = match call.name.as_str() {
            "apply_patch" => {
                miniq_tools::apply_patch_affected_paths(&call.arguments).unwrap_or_default()
            }
            "file_write" | "file_edit" | "doc_write" | "file_patch" | "notebook_edit" => call
                .arguments
                .get("path")
                .and_then(|path| path.as_str())
                .map(|path| vec![path.to_string()])
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        paths
            .iter()
            .filter_map(|path| self.take_checkpoint(path, tool_call_id))
            .collect()
    }

    /// Record what each checkpointed file looks like after the tool ran, so a
    /// later turn rollback can detect edits made after this point.
    pub(super) fn record_checkpoint_results(&self, checkpoints: &[CheckpointRow]) {
        for checkpoint in checkpoints {
            let state = match file_state(std::path::Path::new(&checkpoint.abs_path)) {
                Ok(state) => state,
                Err(error) => {
                    tracing::warn!(checkpoint = %checkpoint.id, %error, "failed to read file state after tool call");
                    continue;
                }
            };
            if let Err(error) = self
                .state
                .store
                .set_checkpoint_after_state(&checkpoint.id, &state)
            {
                tracing::warn!(checkpoint = %checkpoint.id, %error, "failed to record checkpoint state");
            }
        }
    }

    fn take_checkpoint(&self, requested: &str, tool_call_id: &str) -> Option<CheckpointRow> {
        let abs = self.ctx.resolve_path(requested).ok()?;
        let existed = abs.is_file();
        let backup_path = if existed {
            let backup = self.state.checkpoints_dir.join(format!(
                "{}-{}",
                miniq_memory::new_id("bk"),
                abs.file_name()?.to_string_lossy()
            ));
            std::fs::create_dir_all(&self.state.checkpoints_dir).ok()?;
            std::fs::copy(&abs, &backup).ok()?;
            Some(backup.to_string_lossy().to_string())
        } else {
            None
        };
        self.state
            .store
            .create_checkpoint(
                &self.session_id,
                tool_call_id,
                &abs.to_string_lossy(),
                existed,
                backup_path.as_deref(),
            )
            .ok()
    }
}
