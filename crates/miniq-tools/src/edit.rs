//! file_edit: exact-match string replacement with uniqueness enforcement.
//!
//! The uniqueness requirement is the correctness win over sed-style edits:
//! if `oldString` matches more than once the tool refuses (reporting the
//! count) unless `replaceAll` is set, so the model cannot silently edit the
//! wrong occurrence.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub struct FileEditTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileEditInput {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[async_trait]
impl Tool for FileEditTool {
    fn name(&self) -> &str {
        "file_edit"
    }
    fn description(&self) -> &str {
        "Replace an exact string in a text file. oldString must match exactly once \
         unless replaceAll is true. Requires approval."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to the workspace root"},
                "oldString": {"type": "string", "description": "Exact text to replace (include enough context to be unique)"},
                "newString": {"type": "string", "description": "Replacement text"},
                "replaceAll": {"type": "boolean", "description": "Replace every occurrence instead of requiring a unique match"}
            },
            "required": ["path", "oldString", "newString"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        crate::file::path_risk(
            ctx,
            input,
            RiskLevel::Medium,
            "edits a file in the workspace",
        )
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileEditInput = parse_input(input)?;
        if p.old_string.is_empty() {
            return Err(ToolError::InvalidInput(
                "oldString must not be empty".into(),
            ));
        }
        if p.old_string == p.new_string {
            return Err(ToolError::InvalidInput(
                "oldString and newString are identical".into(),
            ));
        }
        let path = resolve_in_workspace(&ctx.workspace, &p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read {}: {e}", path.display())))?;

        let count = content.matches(&p.old_string).count();
        if count == 0 {
            return Err(ToolError::ExecutionFailed(format!(
                "oldString not found in {}",
                p.path
            )));
        }
        if count > 1 && !p.replace_all {
            return Err(ToolError::ExecutionFailed(format!(
                "oldString matches {count} times in {}; add more context to make it \
                 unique, or set replaceAll=true",
                p.path
            )));
        }

        let (updated, replacements) = if p.replace_all {
            (content.replace(&p.old_string, &p.new_string), count)
        } else {
            (content.replacen(&p.old_string, &p.new_string, 1), 1)
        };
        tokio::fs::write(&path, &updated)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("write {}: {e}", path.display())))?;
        Ok(json!({ "path": p.path, "replacements": replacements }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(dir: &std::path::Path) -> ToolContext {
        ToolContext::new(dir.to_path_buf())
    }

    #[tokio::test]
    async fn unique_replacement() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world\ngoodbye world").unwrap();
        let out = FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "a.txt", "oldString": "hello", "newString": "hi"}),
            )
            .await
            .unwrap();
        assert_eq!(out["replacements"], 1);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "hi world\ngoodbye world"
        );
    }

    #[tokio::test]
    async fn ambiguous_match_rejected_with_count() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x world x world").unwrap();
        let err = FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "a.txt", "oldString": "world", "newString": "earth"}),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("2 times"), "got: {err}");
    }

    #[tokio::test]
    async fn replace_all() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a b a b a").unwrap();
        let out = FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "a.txt", "oldString": "a", "newString": "z", "replaceAll": true}),
            )
            .await
            .unwrap();
        assert_eq!(out["replacements"], 3);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "z b z b z"
        );
    }

    #[tokio::test]
    async fn missing_string_and_escape_denied() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "content").unwrap();
        let err = FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "a.txt", "oldString": "nope", "newString": "x"}),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));

        let err = FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "../a.txt", "oldString": "a", "newString": "b"}),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::SandboxDenied(_)));

        let risk = FileEditTool.evaluate_risk(&ctx(dir.path()), &json!({"path": "a.txt"}));
        assert_eq!(risk.level, RiskLevel::Medium);
    }
}
