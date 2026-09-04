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
const GREP_MAX_RESULTS: usize = 1000;
const GREP_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileGlobInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
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
                "path": {"type": "string", "description": "Directory to search in, relative to the workspace root; defaults to the root"},
                "offset": {"type": "integer", "minimum": 0, "description": "Result offset for pagination"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 500, "description": "Page size (default and maximum 500)"}
            },
            "required": ["pattern"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        base_path_risk(ctx, input, "read-only file name search")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileGlobInput = parse_input(input)?;
        if p.limit
            .is_some_and(|limit| !(1..=GLOB_MAX_RESULTS).contains(&limit))
        {
            return Err(ToolError::InvalidInput(
                "limit must be between 1 and 500".into(),
            ));
        }
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
        let limit = p.limit.unwrap_or(GLOB_MAX_RESULTS);
        let files: Vec<String> = matches
            .into_iter()
            .skip(p.offset)
            .take(limit)
            .map(|(path, _)| path)
            .collect();
        let next_offset = p.offset + files.len();
        Ok(json!({
            "pattern": p.pattern,
            "files": files,
            "total": total,
            "offset": p.offset,
            "nextOffset": (next_offset < total).then_some(next_offset),
            "truncated": next_offset < total,
        }))
    }
}

// ---- file_grep ----

pub struct FileGrepTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    output_mode: GrepOutputMode,
    #[serde(default)]
    multiline: bool,
    #[serde(default)]
    before_context: usize,
    #[serde(default)]
    after_context: usize,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum GrepOutputMode {
    #[default]
    Content,
    FilesWithMatches,
    Count,
}

impl GrepOutputMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::FilesWithMatches => "files_with_matches",
            Self::Count => "count",
        }
    }
}

#[async_trait]
impl Tool for FileGrepTool {
    fn name(&self) -> &str {
        "file_grep"
    }
    fn description(&self) -> &str {
        "Search file contents with a regular expression. Supports content, file-list and \
         count outputs, explicit pagination and multiline matching."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Rust-flavored regular expression"},
                "path": {"type": "string", "description": "Directory to search in; defaults to the workspace root"},
                "glob": {"type": "string", "description": "Only search files matching this glob, e.g. *.md"},
                "caseInsensitive": {"type": "boolean"},
                "maxResults": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "Page size (default 100)"},
                "offset": {"type": "integer", "minimum": 0, "description": "Result offset for pagination"},
                "outputMode": {"type": "string", "enum": ["content", "files_with_matches", "count"]},
                "multiline": {"type": "boolean", "description": "Allow matches to span lines"},
                "beforeContext": {"type": "integer", "minimum": 0},
                "afterContext": {"type": "integer", "minimum": 0}
            },
            "required": ["pattern"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        base_path_risk(ctx, input, "read-only content search")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: FileGrepInput = parse_input(input)?;
        if p.max_results
            .is_some_and(|limit| !(1..=GREP_MAX_RESULTS).contains(&limit))
        {
            return Err(ToolError::InvalidInput(
                "maxResults must be between 1 and 1000".into(),
            ));
        }
        let base = resolve_base(ctx, p.path.as_deref())?;
        let regex = regex::RegexBuilder::new(&p.pattern)
            .case_insensitive(p.case_insensitive)
            .multi_line(p.multiline)
            .dot_matches_new_line(p.multiline)
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
        let max_results = p.max_results.unwrap_or(GREP_DEFAULT_MAX_RESULTS);
        let offset = p.offset;
        let mode = p.output_mode;
        let multiline = p.multiline;
        let before_context = p.before_context;
        let after_context = p.after_context;

        let workspace = ctx.workspace.clone();
        let (results, total, files_scanned, skipped_large_files) =
            tokio::task::spawn_blocking(move || {
                let mut results = Vec::new();
                let mut total = 0usize;
                let mut files_scanned = 0usize;
                let mut skipped_large_files = Vec::new();
                for entry in walker(&base).flatten() {
                    let path = entry.path();
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        continue;
                    }
                    if let Some(filter) = &name_filter {
                        let relative = path.strip_prefix(&base).unwrap_or(path);
                        if !filter.is_match(relative)
                            && !filter.is_match(path.file_name().unwrap_or_default())
                        {
                            continue;
                        }
                    }
                    if entry.metadata().map(|m| m.len()).unwrap_or(0) > GREP_MAX_FILE_BYTES {
                        skipped_large_files.push(workspace_relative(path, &workspace));
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
                    let relative = workspace_relative(path, &workspace);
                    let file_matches = grep_file_matches(&regex, &content, multiline);
                    if file_matches.is_empty() {
                        continue;
                    }
                    let items = match mode {
                        GrepOutputMode::Content => file_matches
                            .into_iter()
                            .map(|matched| {
                                content_match(
                                    &relative,
                                    &content,
                                    matched,
                                    before_context,
                                    after_context,
                                )
                            })
                            .collect::<Vec<_>>(),
                        GrepOutputMode::FilesWithMatches => vec![json!(relative)],
                        GrepOutputMode::Count => {
                            vec![json!({"path": relative, "count": file_matches.len()})]
                        }
                    };
                    for item in items {
                        if total >= offset && results.len() < max_results {
                            results.push(item);
                        }
                        total += 1;
                    }
                }
                (results, total, files_scanned, skipped_large_files)
            })
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;

        let next_offset = offset + results.len();
        let mut output = json!({
            "pattern": p.pattern,
            "outputMode": mode.as_str(),
            "total": total,
            "offset": offset,
            "nextOffset": (next_offset < total).then_some(next_offset),
            "truncated": next_offset < total,
            "filesScanned": files_scanned,
            "skippedLargeFiles": skipped_large_files,
        });
        output[match mode {
            GrepOutputMode::Content => "matches",
            GrepOutputMode::FilesWithMatches => "files",
            GrepOutputMode::Count => "counts",
        }] = Value::Array(results);
        Ok(output)
    }
}

struct GrepMatch {
    line: usize,
    end_line: usize,
    text: String,
}

fn grep_file_matches(regex: &regex::Regex, content: &str, multiline: bool) -> Vec<GrepMatch> {
    if multiline {
        return regex
            .find_iter(content)
            .map(|matched| {
                let line = content[..matched.start()]
                    .bytes()
                    .filter(|byte| *byte == b'\n')
                    .count()
                    + 1;
                GrepMatch {
                    line,
                    end_line: line + matched.as_str().matches('\n').count(),
                    text: matched.as_str().to_string(),
                }
            })
            .collect();
    }
    content
        .lines()
        .enumerate()
        .filter(|(_, line)| regex.is_match(line))
        .map(|(line, text)| GrepMatch {
            line: line + 1,
            end_line: line + 1,
            text: text.to_string(),
        })
        .collect()
}

fn content_match(
    path: &str,
    content: &str,
    matched: GrepMatch,
    before_context: usize,
    after_context: usize,
) -> Value {
    let lines = content.lines().collect::<Vec<_>>();
    let before_start = matched.line.saturating_sub(before_context + 1);
    let after_end = (matched.end_line + after_context).min(lines.len());
    json!({
        "path": path,
        "line": matched.line,
        "endLine": matched.end_line,
        "text": matched.text,
        "before": lines[before_start..matched.line.saturating_sub(1)],
        "after": lines[matched.end_line.min(lines.len())..after_end],
    })
}

#[cfg(test)]
mod tests;
