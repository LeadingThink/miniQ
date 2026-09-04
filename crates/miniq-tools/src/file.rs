//! File tools: read, list, write. All paths are resolved and contained in
//! the workspace via miniq-sandbox.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub(crate) fn path_risk(ctx: &ToolContext, input: &Value, base: RiskLevel, reason: &str) -> Risk {
    let Some(path) = input.get("path").and_then(|p| p.as_str()) else {
        return Risk {
            level: RiskLevel::Blocked,
            reason: "missing path".into(),
        };
    };
    match resolve_in_workspace(&ctx.workspace, path) {
        Ok(_) => Risk {
            level: base,
            reason: reason.to_string(),
        },
        Err(e) => Risk {
            level: RiskLevel::Blocked,
            reason: e.to_string(),
        },
    }
}

// ---- file_read ----

pub struct FileReadTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileReadInput {
    path: String,
    /// 1-based line to start from.
    #[serde(default)]
    offset: Option<usize>,
    /// Max number of lines to return.
    #[serde(default)]
    limit: Option<usize>,
}

#[async_trait]
impl Tool for FileReadTool {
    fn name(&self) -> &str {
        "file_read"
    }
    fn description(&self) -> &str {
        "Read a text file inside the workspace. Supports optional line offset/limit paging."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path, relative to the workspace root"},
                "offset": {"type": "integer", "minimum": 1, "description": "1-based first line to read"},
                "limit": {"type": "integer", "minimum": 1, "description": "Maximum number of lines to return"}
            },
            "required": ["path"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(ctx, input, RiskLevel::Low, "read-only file access")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileReadInput = parse_input(input)?;
        if p.offset == Some(0) || p.limit == Some(0) {
            return Err(ToolError::InvalidInput(
                "offset and limit must be positive integers".into(),
            ));
        }
        let path = resolve_in_workspace(&ctx.workspace, &p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read {}: {e}", path.display())))?;
        let total_lines = content.lines().count();
        let offset = p.offset.unwrap_or(1);
        let selected: String = match p.limit {
            Some(limit) => content
                .lines()
                .skip(offset - 1)
                .take(limit)
                .collect::<Vec<_>>()
                .join("\n"),
            None if offset > 1 => content
                .lines()
                .skip(offset - 1)
                .collect::<Vec<_>>()
                .join("\n"),
            None => content,
        };
        Ok(json!({
            "path": p.path,
            "content": selected,
            "totalLines": total_lines,
            "offset": offset,
        }))
    }
}

// ---- file_list ----

pub struct FileListTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileListInput {
    #[serde(default = "default_dot")]
    path: String,
}

fn default_dot() -> String {
    ".".to_string()
}

#[async_trait]
impl Tool for FileListTool {
    fn name(&self) -> &str {
        "file_list"
    }
    fn description(&self) -> &str {
        "List directory entries inside the workspace."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path relative to the workspace root; defaults to the root"}
            }
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        // Missing path defaults to workspace root, which is always allowed.
        if input.get("path").is_none() {
            return Risk {
                level: RiskLevel::Low,
                reason: "list workspace root".into(),
            };
        }
        path_risk(ctx, input, RiskLevel::Low, "read-only directory listing")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileListInput = parse_input(input)?;
        let path = resolve_in_workspace(&ctx.workspace, &p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let mut reader = tokio::fs::read_dir(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("list {}: {e}", path.display())))?;
        let mut entries = Vec::new();
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?
        {
            let meta = entry
                .metadata()
                .await
                .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
            entries.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "kind": if meta.is_dir() { "dir" } else { "file" },
                "size": meta.len(),
            }));
        }
        entries.sort_by(|a, b| {
            let ak = (
                a["kind"].as_str().unwrap_or(""),
                a["name"].as_str().unwrap_or("").to_string(),
            );
            let bk = (
                b["kind"].as_str().unwrap_or(""),
                b["name"].as_str().unwrap_or("").to_string(),
            );
            ak.cmp(&bk)
        });
        Ok(json!({ "path": p.path, "entries": entries }))
    }
}

// ---- file_write ----

pub struct FileWriteTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileWriteInput {
    path: String,
    content: String,
}

#[async_trait]
impl Tool for FileWriteTool {
    fn name(&self) -> &str {
        "file_write"
    }
    fn description(&self) -> &str {
        "Create or overwrite a text file inside the workspace. Requires approval."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to the workspace root"},
                "content": {"type": "string", "description": "Full new file content"}
            },
            "required": ["path", "content"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(
            ctx,
            input,
            RiskLevel::Medium,
            "writes a file in the workspace",
        )
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileWriteInput = parse_input(input)?;
        let path = resolve_in_workspace(&ctx.workspace, &p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        }
        let existed = path.exists();
        tokio::fs::write(&path, &p.content)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("write {}: {e}", path.display())))?;
        Ok(json!({
            "path": p.path,
            "bytesWritten": p.content.len(),
            "created": !existed,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(dir: &std::path::Path) -> ToolContext {
        ToolContext::new(dir.to_path_buf())
    }

    #[tokio::test]
    async fn read_and_list() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "line1\nline2\nline3").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let out = FileReadTool
            .execute(&ctx(dir.path()), json!({"path": "a.txt"}))
            .await
            .unwrap();
        assert_eq!(out["content"], "line1\nline2\nline3");
        assert_eq!(out["totalLines"], 3);

        let out = FileReadTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "a.txt", "offset": 2, "limit": 1}),
            )
            .await
            .unwrap();
        assert_eq!(out["content"], "line2");

        let out = FileListTool
            .execute(&ctx(dir.path()), json!({}))
            .await
            .unwrap();
        let entries = out["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["kind"], "dir");
    }

    #[tokio::test]
    async fn escape_is_denied() {
        let dir = tempfile::tempdir().unwrap();
        let err = FileReadTool
            .execute(&ctx(dir.path()), json!({"path": "../secret.txt"}))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::SandboxDenied(_)));

        let risk = FileReadTool.evaluate_risk(&ctx(dir.path()), &json!({"path": "../x"}));
        assert_eq!(risk.level, RiskLevel::Blocked);
    }

    #[tokio::test]
    async fn write_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let out = FileWriteTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "new/dir/file.txt", "content": "hello"}),
            )
            .await
            .unwrap();
        assert_eq!(out["created"], true);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("new/dir/file.txt")).unwrap(),
            "hello"
        );
        let risk = FileWriteTool.evaluate_risk(&ctx(dir.path()), &json!({"path": "x.txt"}));
        assert_eq!(risk.level, RiskLevel::Medium);
    }
}
