//! File tools: read, list, write. All paths are resolved and contained in
//! the workspace via miniq-sandbox.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::line_ending;
use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub(crate) fn path_risk(ctx: &ToolContext, input: &Value, base: RiskLevel, reason: &str) -> Risk {
    let Some(path) = input.get("path").and_then(|p| p.as_str()) else {
        return Risk {
            level: RiskLevel::Blocked,
            reason: "missing path".into(),
        };
    };
    match if base == RiskLevel::Low {
        ctx.resolve_read_path(path)
    } else {
        ctx.resolve_path(path)
    } {
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
        let Some(path) = input.get("path").and_then(Value::as_str) else {
            return Risk {
                level: RiskLevel::Blocked,
                reason: "missing path".into(),
            };
        };
        match ctx.resolve_read_path(path) {
            Ok(_) => Risk {
                level: RiskLevel::Low,
                reason: "read-only file access".into(),
            },
            Err(error) if std::path::Path::new(path).is_absolute() => {
                let external = dunce::canonicalize(path).ok().filter(|file| file.is_file());
                match external {
                    Some(file) => Risk {
                        level: RiskLevel::High,
                        reason: format!("读取工作区外的文件，需要明确批准: {}", file.display()),
                    },
                    None => Risk {
                        level: RiskLevel::Blocked,
                        reason: error.to_string(),
                    },
                }
            }
            Err(error) => Risk {
                level: RiskLevel::Blocked,
                reason: error.to_string(),
            },
        }
    }

    fn approval_scope(&self, _ctx: &ToolContext, input: &Value) -> Option<String> {
        let path = input.get("path").and_then(Value::as_str)?;
        let file = dunce::canonicalize(path)
            .ok()?
            .to_string_lossy()
            .into_owned();
        Some(format!("external-file:{file}"))
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileReadInput = parse_input(input)?;
        if p.offset == Some(0) || p.limit == Some(0) {
            return Err(ToolError::InvalidInput(
                "offset and limit must be positive integers".into(),
            ));
        }
        let path = ctx
            .resolve_read_path(&p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read {}: {e}", path.display())))?;
        let total_lines = content.lines().count();
        let offset = p.offset.unwrap_or(1);
        // Always hand the model LF, whether or not a page window was requested.
        // Returning raw bytes for the whole-file case used to make the same
        // tool disagree with itself about a CRLF target.
        let eol = line_ending::summary(&content);
        let normalized = line_ending::to_lf(&content);
        let selected: String = match p.limit {
            Some(limit) => normalized
                .lines()
                .skip(offset - 1)
                .take(limit)
                .collect::<Vec<_>>()
                .join("\n"),
            None if offset > 1 => normalized
                .lines()
                .skip(offset - 1)
                .collect::<Vec<_>>()
                .join("\n"),
            None => normalized,
        };
        Ok(json!({
            "path": p.path,
            "content": selected,
            "totalLines": total_lines,
            "offset": offset,
            "eol": eol,
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
        let path = ctx
            .resolve_path(&p.path)
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
        let path = ctx
            .resolve_path(&p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        }
        let existed = path.exists();
        // Overwriting an existing CRLF file keeps CRLF. `restore` keeps the
        // terminators of lines the rewrite did not change and uses the file's
        // preferred terminator for new ones; a full rewrite simply lands on the
        // preferred terminator throughout. Silently downgrading to LF would
        // rewrite every line in the user's diff.
        let content = match existed {
            true => match tokio::fs::read_to_string(&path).await {
                Ok(previous) => line_ending::restore(&previous, &p.content),
                Err(_) => p.content.clone(),
            },
            false => p.content.clone(),
        };
        tokio::fs::write(&path, &content)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("write {}: {e}", path.display())))?;
        Ok(json!({
            "path": p.path,
            "bytesWritten": content.len(),
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
        assert_eq!(out["eol"], "lf");

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

    /// The whole-file read used to return raw bytes while the paged read
    /// returned LF, so the same tool disagreed with itself about one file.
    /// Both paths must now hand the model LF and report the real ending.
    #[tokio::test]
    async fn read_normalises_crlf_and_reports_eol() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        let tool = FileReadTool;

        let whole = tool
            .execute(&ctx(dir.path()), json!({"path": "a.txt"}))
            .await
            .unwrap();
        assert_eq!(whole["content"], "one\ntwo\nthree\n");
        assert_eq!(whole["eol"], "crlf");

        let paged = tool
            .execute(&ctx(dir.path()), json!({"path": "a.txt", "offset": 2, "limit": 1}))
            .await
            .unwrap();
        assert_eq!(paged["content"], "two");
        assert_eq!(paged["eol"], "crlf");
    }

    /// Overwriting an existing CRLF file must not downgrade it to LF.
    #[tokio::test]
    async fn write_preserves_existing_crlf() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\r\ntwo\r\n").unwrap();
        FileWriteTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "a.txt", "content": "one\nTWO\n"}),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "one\r\nTWO\r\n"
        );
    }

    /// A brand-new file follows the caller's content, i.e. stays LF.
    #[tokio::test]
    async fn write_of_a_new_file_keeps_lf() {
        let dir = tempfile::tempdir().unwrap();
        FileWriteTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "new.txt", "content": "one\ntwo\n"}),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            "one\ntwo\n"
        );
    }

    #[tokio::test]
    async fn external_file_read_requires_explicit_read_authorization() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("readme.md");
        std::fs::write(&file, "outside").unwrap();
        let input = json!({"path": file});
        let restricted = ctx(workspace.path());

        assert_eq!(
            FileReadTool.evaluate_risk(&restricted, &input).level,
            RiskLevel::High
        );
        assert!(FileReadTool
            .execute(&restricted, input.clone())
            .await
            .is_err());

        let allowed = restricted.with_readable_file(dunce::canonicalize(&file).unwrap());
        assert_eq!(
            FileReadTool.execute(&allowed, input).await.unwrap()["content"],
            "outside"
        );
    }
}
