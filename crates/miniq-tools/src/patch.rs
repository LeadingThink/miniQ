//! file_patch: apply multiple exact-match edits to one file atomically.
//! All edits are validated against the current content before anything is
//! written, so a failed edit leaves the file untouched.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::file::path_risk;
use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub struct FilePatchTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePatchInput {
    path: String,
    edits: Vec<EditItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditItem {
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[async_trait]
impl Tool for FilePatchTool {
    fn name(&self) -> &str {
        "file_patch"
    }
    fn description(&self) -> &str {
        "Apply several exact-string edits to one file in a single atomic operation. \
         Each oldString must match exactly once unless replaceAll. Requires approval."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "oldString": {"type": "string"},
                            "newString": {"type": "string"},
                            "replaceAll": {"type": "boolean"}
                        },
                        "required": ["oldString", "newString"]
                    }
                }
            },
            "required": ["path", "edits"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(
            ctx,
            input,
            RiskLevel::Medium,
            "patches a file in the workspace",
        )
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FilePatchInput = parse_input(input)?;
        if p.edits.is_empty() {
            return Err(ToolError::InvalidInput("edits must not be empty".into()));
        }
        let path = resolve_in_workspace(&ctx.workspace, &p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let mut content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read {}: {e}", path.display())))?;

        // Validate and apply sequentially in memory; only write at the end.
        let mut total = 0usize;
        for (i, edit) in p.edits.iter().enumerate() {
            if edit.old_string.is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "edit {i}: empty oldString"
                )));
            }
            let count = content.matches(&edit.old_string).count();
            if count == 0 {
                return Err(ToolError::ExecutionFailed(format!(
                    "edit {i}: oldString not found (no changes applied)"
                )));
            }
            if count > 1 && !edit.replace_all {
                return Err(ToolError::ExecutionFailed(format!(
                    "edit {i}: oldString matches {count} times; add context or set \
                     replaceAll (no changes applied)"
                )));
            }
            if edit.replace_all {
                content = content.replace(&edit.old_string, &edit.new_string);
                total += count;
            } else {
                content = content.replacen(&edit.old_string, &edit.new_string, 1);
                total += 1;
            }
        }
        tokio::fs::write(&path, &content)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("write {}: {e}", path.display())))?;
        Ok(json!({ "path": p.path, "edits": p.edits.len(), "replacements": total }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomic_multi_edit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "alpha beta gamma beta").unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());

        let out = FilePatchTool
            .execute(
                &ctx,
                json!({"path": "f.txt", "edits": [
                    {"oldString": "alpha", "newString": "A"},
                    {"oldString": "beta", "newString": "B", "replaceAll": true}
                ]}),
            )
            .await
            .unwrap();
        assert_eq!(out["replacements"], 3);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "A B gamma B"
        );
    }

    #[tokio::test]
    async fn failed_edit_leaves_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "original").unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());

        let err = FilePatchTool
            .execute(
                &ctx,
                json!({"path": "f.txt", "edits": [
                    {"oldString": "original", "newString": "changed"},
                    {"oldString": "MISSING", "newString": "x"}
                ]}),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no changes applied"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "original"
        );
    }
}
