//! Read-only git tools: status and diff. Implemented by invoking the git CLI
//! with the workspace as working directory and parsing the output into
//! structured JSON.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

async fn run_git(ctx: &ToolContext, args: &[&str]) -> Result<std::process::Output, ToolError> {
    tokio::process::Command::new("git")
        .args(args)
        .current_dir(&ctx.workspace)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| ToolError::ExecutionFailed(format!("git: {e}")))
}

fn low_risk(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Low,
        reason: reason.to_string(),
    }
}

// ---- git_status ----

pub struct GitStatusTool;

#[async_trait]
impl Tool for GitStatusTool {
    fn name(&self) -> &str {
        "git_status"
    }
    fn description(&self) -> &str {
        "Show git working tree status (branch plus changed files)."
    }
    fn parameters_schema(&self) -> Value {
        json!({"type": "object", "properties": {}})
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk("read-only git status")
    }
    async fn execute(&self, ctx: &ToolContext, _input: Value) -> Result<Value, ToolError> {
        let output = run_git(ctx, &["status", "--porcelain=v1", "--branch"]).await?;
        if !output.status.success() {
            return Err(ToolError::ExecutionFailed(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut branch = String::new();
        let mut files = Vec::new();
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                branch = rest.to_string();
            } else if line.len() >= 3 {
                files.push(json!({
                    "status": line[..2].trim(),
                    "path": line[3..].to_string(),
                }));
            }
        }
        Ok(json!({ "branch": branch, "files": files, "clean": files.is_empty() }))
    }
}

// ---- git_diff ----

pub struct GitDiffTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffInput {
    #[serde(default)]
    staged: bool,
    #[serde(default)]
    path: Option<String>,
}

#[async_trait]
impl Tool for GitDiffTool {
    fn name(&self) -> &str {
        "git_diff"
    }
    fn description(&self) -> &str {
        "Show the git diff of the working tree (or the staged index with staged=true), \
         optionally limited to one path."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "staged": {"type": "boolean", "description": "Diff the staged index instead of the working tree"},
                "path": {"type": "string", "description": "Limit the diff to this path"}
            }
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk("read-only git diff")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: GitDiffInput = parse_input(input)?;
        let mut args: Vec<&str> = vec!["diff"];
        if p.staged {
            args.push("--cached");
        }
        if let Some(path) = &p.path {
            // Containment: the path filter must stay inside the workspace.
            miniq_sandbox::resolve_in_workspace(&ctx.workspace, path)
                .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
            args.push("--");
            args.push(path);
        }
        let output = run_git(ctx, &args).await?;
        if !output.status.success() {
            return Err(ToolError::ExecutionFailed(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }
        Ok(json!({
            "staged": p.staged,
            "diff": String::from_utf8_lossy(&output.stdout),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_and_diff_in_fresh_repo() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let init = tokio::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .output()
            .await
            .unwrap();
        assert!(init.status.success());
        std::fs::write(dir.path().join("hello.txt"), "hi").unwrap();

        let out = GitStatusTool.execute(&ctx, json!({})).await.unwrap();
        assert_eq!(out["clean"], false);
        let files = out["files"].as_array().unwrap();
        assert_eq!(files[0]["path"], "hello.txt");
        assert_eq!(files[0]["status"], "??");

        // Untracked files produce an empty diff; the call itself must succeed.
        let out = GitDiffTool.execute(&ctx, json!({})).await.unwrap();
        assert_eq!(out["diff"], "");
    }
}
