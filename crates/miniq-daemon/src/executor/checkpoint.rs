use miniq_models::ToolCallRequest;

use super::SessionToolExecutor;

impl SessionToolExecutor {
    pub(super) fn take_checkpoints(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
    ) -> Vec<String> {
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

    fn take_checkpoint(&self, requested: &str, tool_call_id: &str) -> Option<String> {
        let abs = miniq_sandbox::resolve_in_workspace(&self.ctx.workspace, requested).ok()?;
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
        let row = self
            .state
            .store
            .create_checkpoint(
                &self.session_id,
                tool_call_id,
                &abs.to_string_lossy(),
                existed,
                backup_path.as_deref(),
            )
            .ok()?;
        Some(row.id)
    }
}
