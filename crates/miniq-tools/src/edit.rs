//! file_edit: exact-match string replacement with uniqueness enforcement.
//!
//! The uniqueness requirement is the correctness win over sed-style edits:
//! if `oldString` matches more than once the tool refuses (reporting the
//! count) unless `replaceAll` is set, so the model cannot silently edit the
//! wrong occurrence.
//!
//! Matching runs against the LF view of the file and the result is restored
//! to the file's own terminators, so a CRLF target matches exactly like an LF
//! one and keeps its CRLF endings after the edit.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::line_ending;
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
        let path = ctx
            .resolve_path(&p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let original = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read {}: {e}", path.display())))?;

        // Match against the same LF view `file_read` hands the model, so the
        // two tools can never disagree about a file's line endings.
        let view = line_ending::to_lf(&original);
        let old_string = line_ending::to_lf(&p.old_string);
        let new_string = line_ending::to_lf(&p.new_string);
        if old_string.is_empty() {
            return Err(ToolError::InvalidInput(
                "oldString must not be empty".into(),
            ));
        }

        let count = view.matches(old_string.as_str()).count();
        if count == 0 {
            return Err(ToolError::ExecutionFailed(format!(
                "oldString not found in {} ({} line endings)",
                p.path,
                line_ending::summary(&original)
            )));
        }
        if count > 1 && !p.replace_all {
            return Err(ToolError::ExecutionFailed(format!(
                "oldString matches {count} times in {}; add more context to make it \
                 unique, or set replaceAll=true",
                p.path
            )));
        }

        let (edited, replacements) = if p.replace_all {
            (view.replace(old_string.as_str(), &new_string), count)
        } else {
            (view.replacen(old_string.as_str(), &new_string, 1), 1)
        };
        // Put the file's own terminators back: an edit to a CRLF file stays
        // CRLF instead of silently rewriting every line.
        let updated = line_ending::restore(&original, &edited);
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

    /// A CRLF target must match the LF `oldString` the model just read.
    #[tokio::test]
    async fn crlf_target_matches_lf_old_string() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.py"),
            "def f():\r\n    return 1\r\n\r\nprint(f())\r\n",
        )
        .unwrap();
        let out = FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({
                    "path": "a.py",
                    "oldString": "def f():\n    return 1",
                    "newString": "def f():\n    return 2"
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["replacements"], 1);
        // Every terminator survives, including the untouched ones.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.py")).unwrap(),
            "def f():\r\n    return 2\r\n\r\nprint(f())\r\n"
        );
    }

    /// `oldString` that already carries CRLF must also match.
    #[tokio::test]
    async fn crlf_old_string_also_matches() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\r\ntwo\r\n").unwrap();
        let out = FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({
                    "path": "a.txt",
                    "oldString": "one\r\ntwo",
                    "newString": "one\r\nTWO"
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["replacements"], 1);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "one\r\nTWO\r\n"
        );
    }

    /// A mixed-ending file keeps the terminators of lines the edit did not touch.
    #[tokio::test]
    async fn mixed_endings_keep_untouched_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a\r\nb\nc\r\n").unwrap();
        FileEditTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "a.txt", "oldString": "b", "newString": "B"}),
            )
            .await
            .unwrap();
        let written = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(written, "a\r\nB\r\nc\r\n");
        assert_eq!(written.matches("\r\n").count(), 3);
    }
}
