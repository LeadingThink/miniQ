//! file_glob and file_grep: workspace file discovery and content search.
//!
//! Both walk the workspace with the `ignore` crate (respects .gitignore,
//! always skips `.git/`) and cap result counts with an explicit `truncated`
//! flag — paging is explicit, results are never silently cut.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

const GLOB_MAX_RESULTS: usize = 500;
const GREP_DEFAULT_MAX_RESULTS: usize = 100;
const GREP_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const GREP_MAX_LINE_CHARS: usize = 500;

fn low_risk(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Low,
        reason: reason.to_string(),
    }
}

/// Base-path risk: default (missing path) is the workspace root; an explicit
/// path must stay inside the workspace.
fn base_path_risk(ctx: &ToolContext, input: &Value, reason: &str) -> Risk {
    match input.get("path").and_then(|p| p.as_str()) {
        None => low_risk(reason),
        Some(path) => match resolve_in_workspace(&ctx.workspace, path) {
            Ok(_) => low_risk(reason),
            Err(e) => Risk {
                level: RiskLevel::Blocked,
                reason: e.to_string(),
            },
        },
    }
}

fn resolve_base(ctx: &ToolContext, path: Option<&str>) -> Result<PathBuf, ToolError> {
    match path {
        Some(p) => resolve_in_workspace(&ctx.workspace, p)
            .map_err(|e| ToolError::SandboxDenied(e.to_string())),
        None => Ok(ctx.workspace.clone()),
    }
}

fn walker(base: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(base)
        // Allow dotfiles; `.git/` itself is still skipped by the walker.
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .require_git(false)
        .build()
}

fn workspace_relative(path: &Path, workspace: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

// ---- file_glob ----

pub struct FileGlobTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileGlobInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
}

#[async_trait]
impl Tool for FileGlobTool {
    fn name(&self) -> &str {
        "file_glob"
    }
    fn description(&self) -> &str {
        "Find files by glob pattern (e.g. **/*.xlsx). Respects .gitignore; results \
         are sorted by modification time, newest first."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern like **/*.rs or reports/*.docx"},
                "path": {"type": "string", "description": "Directory to search in, relative to the workspace root; defaults to the root"}
            },
            "required": ["pattern"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        base_path_risk(ctx, input, "read-only file name search")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileGlobInput = parse_input(input)?;
        let base = resolve_base(ctx, p.path.as_deref())?;
        let glob = globset::GlobBuilder::new(&p.pattern)
            .literal_separator(true)
            .build()
            .map_err(|e| ToolError::InvalidInput(format!("bad glob pattern: {e}")))?
            .compile_matcher();

        let workspace = ctx.workspace.clone();
        let matches = tokio::task::spawn_blocking(move || {
            let mut found: Vec<(String, std::time::SystemTime)> = Vec::new();
            for entry in walker(&base).flatten() {
                let path = entry.path();
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                let rel_to_base = path.strip_prefix(&base).unwrap_or(path);
                if !glob.is_match(rel_to_base) {
                    continue;
                }
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                found.push((workspace_relative(path, &workspace), mtime));
            }
            found.sort_by(|a, b| b.1.cmp(&a.1));
            found
        })
        .await
        .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;

        let total = matches.len();
        let truncated = total > GLOB_MAX_RESULTS;
        let files: Vec<String> = matches
            .into_iter()
            .take(GLOB_MAX_RESULTS)
            .map(|(path, _)| path)
            .collect();
        Ok(json!({
            "pattern": p.pattern,
            "files": files,
            "total": total,
            "truncated": truncated,
        }))
    }
}

// ---- file_grep ----

pub struct FileGrepTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileGrepInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    /// Optional glob filter on file names, e.g. "*.md".
    #[serde(default)]
    glob: Option<String>,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default)]
    max_results: Option<usize>,
}

#[async_trait]
impl Tool for FileGrepTool {
    fn name(&self) -> &str {
        "file_grep"
    }
    fn description(&self) -> &str {
        "Search file contents with a regular expression. Returns matching lines with \
         file path and line number. Skips binary and oversized files."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Rust-flavored regular expression"},
                "path": {"type": "string", "description": "Directory to search in; defaults to the workspace root"},
                "glob": {"type": "string", "description": "Only search files matching this glob, e.g. *.md"},
                "caseInsensitive": {"type": "boolean"},
                "maxResults": {"type": "integer", "description": "Maximum matching lines to return (default 100)"}
            },
            "required": ["pattern"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        base_path_risk(ctx, input, "read-only content search")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileGrepInput = parse_input(input)?;
        let base = resolve_base(ctx, p.path.as_deref())?;
        let regex = regex::RegexBuilder::new(&p.pattern)
            .case_insensitive(p.case_insensitive)
            .build()
            .map_err(|e| ToolError::InvalidInput(format!("bad regex: {e}")))?;
        let name_filter = match &p.glob {
            Some(g) => Some(
                globset::GlobBuilder::new(g)
                    .build()
                    .map_err(|e| ToolError::InvalidInput(format!("bad glob: {e}")))?
                    .compile_matcher(),
            ),
            None => None,
        };
        let max_results = p.max_results.unwrap_or(GREP_DEFAULT_MAX_RESULTS).max(1);

        let workspace = ctx.workspace.clone();
        let (matches, truncated, files_scanned) = tokio::task::spawn_blocking(move || {
            let mut matches = Vec::new();
            let mut truncated = false;
            let mut files_scanned = 0usize;
            'files: for entry in walker(&base).flatten() {
                let path = entry.path();
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                if let Some(filter) = &name_filter {
                    if !filter.is_match(path.file_name().unwrap_or_default()) {
                        continue;
                    }
                }
                if entry.metadata().map(|m| m.len()).unwrap_or(0) > GREP_MAX_FILE_BYTES {
                    continue;
                }
                let Ok(bytes) = std::fs::read(path) else {
                    continue;
                };
                // Binary detection: NUL byte in the first 8KB.
                if bytes.iter().take(8192).any(|&b| b == 0) {
                    continue;
                }
                let content = String::from_utf8_lossy(&bytes);
                files_scanned += 1;
                for (line_no, line) in content.lines().enumerate() {
                    if regex.is_match(line) {
                        if matches.len() >= max_results {
                            truncated = true;
                            break 'files;
                        }
                        let text: String = line.chars().take(GREP_MAX_LINE_CHARS).collect();
                        matches.push(json!({
                            "path": workspace_relative(path, &workspace),
                            "line": line_no + 1,
                            "text": text,
                        }));
                    }
                }
            }
            (matches, truncated, files_scanned)
        })
        .await
        .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;

        Ok(json!({
            "pattern": p.pattern,
            "matches": matches,
            "truncated": truncated,
            "filesScanned": files_scanned,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(dir: &std::path::Path) -> ToolContext {
        ToolContext::new(dir.to_path_buf())
    }

    fn setup(dir: &std::path::Path) {
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() { println!(\"hi\"); }").unwrap();
        std::fs::write(dir.join("src/lib.rs"), "pub fn add() {}").unwrap();
        std::fs::write(
            dir.join("docs/note.md"),
            "TODO: write the report\nplain line",
        )
        .unwrap();
        std::fs::write(dir.join("binary.bin"), [0u8, 159, 146, 150]).unwrap();
    }

    #[tokio::test]
    async fn glob_matches_and_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        setup(dir.path());
        let out = FileGlobTool
            .execute(&ctx(dir.path()), json!({"pattern": "**/*.rs"}))
            .await
            .unwrap();
        let files: Vec<&str> = out["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap())
            .collect();
        assert_eq!(files.len(), 2);
        assert!(files.contains(&"src/main.rs"));
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn glob_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        setup(dir.path());
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::fs::write(dir.path().join(".gitignore"), "docs/\n").unwrap();
        let out = FileGlobTool
            .execute(&ctx(dir.path()), json!({"pattern": "**/*.md"}))
            .await
            .unwrap();
        assert_eq!(out["files"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn grep_finds_lines_and_skips_binary() {
        let dir = tempfile::tempdir().unwrap();
        setup(dir.path());
        let out = FileGrepTool
            .execute(&ctx(dir.path()), json!({"pattern": "TODO"}))
            .await
            .unwrap();
        let matches = out["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["path"], "docs/note.md");
        assert_eq!(matches[0]["line"], 1);
        assert!(matches[0]["text"].as_str().unwrap().contains("TODO"));
    }

    #[tokio::test]
    async fn grep_case_insensitive_and_glob_filter() {
        let dir = tempfile::tempdir().unwrap();
        setup(dir.path());
        let out = FileGrepTool
            .execute(
                &ctx(dir.path()),
                json!({"pattern": "todo", "caseInsensitive": true, "glob": "*.md"}),
            )
            .await
            .unwrap();
        assert_eq!(out["matches"].as_array().unwrap().len(), 1);

        let out = FileGrepTool
            .execute(
                &ctx(dir.path()),
                json!({"pattern": "todo", "caseInsensitive": true, "glob": "*.rs"}),
            )
            .await
            .unwrap();
        assert_eq!(out["matches"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn grep_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let many: String = (0..50).map(|i| format!("match line {i}\n")).collect();
        std::fs::write(dir.path().join("big.txt"), many).unwrap();
        let out = FileGrepTool
            .execute(
                &ctx(dir.path()),
                json!({"pattern": "match", "maxResults": 10}),
            )
            .await
            .unwrap();
        assert_eq!(out["matches"].as_array().unwrap().len(), 10);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn escape_denied() {
        let dir = tempfile::tempdir().unwrap();
        let risk =
            FileGlobTool.evaluate_risk(&ctx(dir.path()), &json!({"pattern": "*", "path": "../"}));
        assert_eq!(risk.level, RiskLevel::Blocked);
        let err = FileGrepTool
            .execute(&ctx(dir.path()), json!({"pattern": "x", "path": "../"}))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::SandboxDenied(_)));
    }
}
