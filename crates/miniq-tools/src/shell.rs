//! shell.run: execute a command inside the workspace cwd.

use async_trait::async_trait;
use miniq_sandbox::{classify_command, Risk};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 600;

pub struct ShellRunTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellRunInput {
    command: String,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[async_trait]
impl Tool for ShellRunTool {
    fn name(&self) -> &str {
        "shell.run"
    }
    fn description(&self) -> &str {
        "Run a shell command with the workspace root as working directory. \
         Returns exit code, stdout and stderr."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Command line to execute"},
                "timeoutSecs": {"type": "integer", "description": "Timeout in seconds (default 60, max 600)"}
            },
            "required": ["command"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        match input.get("command").and_then(|c| c.as_str()) {
            Some(command) => classify_command(command),
            None => Risk {
                level: miniq_protocol::RiskLevel::Blocked,
                reason: "missing command".into(),
            },
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: ShellRunInput = parse_input(input)?;
        let timeout = p
            .timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .min(MAX_TIMEOUT_SECS);

        let mut cmd = if cfg!(windows) {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(&p.command);
            c
        } else {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c").arg(&p.command);
            c
        };
        cmd.current_dir(&ctx.workspace)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let started = std::time::Instant::now();
        let child = cmd
            .spawn()
            .map_err(|e| ToolError::ExecutionFailed(format!("spawn: {e}")))?;

        let output = tokio::time::timeout(
            std::time::Duration::from_secs(timeout),
            child.wait_with_output(),
        )
        .await;

        let duration_ms = started.elapsed().as_millis() as u64;
        match output {
            Ok(Ok(output)) => Ok(json!({
                "command": p.command,
                "exitCode": output.status.code(),
                "stdout": String::from_utf8_lossy(&output.stdout),
                "stderr": String::from_utf8_lossy(&output.stderr),
                "durationMs": duration_ms,
                "timedOut": false,
            })),
            Ok(Err(e)) => Err(ToolError::ExecutionFailed(format!("wait: {e}"))),
            Err(_elapsed) => Ok(json!({
                "command": p.command,
                "exitCode": null,
                "stdout": "",
                "stderr": format!("command timed out after {timeout}s"),
                "durationMs": duration_ms,
                "timedOut": true,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::RiskLevel;

    #[tokio::test]
    async fn runs_echo() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext {
            workspace: dir.path().to_path_buf(),
        };
        let out = ShellRunTool
            .execute(&ctx, json!({"command": "echo hello-miniq"}))
            .await
            .unwrap();
        assert_eq!(out["exitCode"], 0);
        assert!(out["stdout"].as_str().unwrap().contains("hello-miniq"));
    }

    #[test]
    fn risk_delegates_to_classifier() {
        let ctx = ToolContext {
            workspace: std::path::PathBuf::from("."),
        };
        assert_eq!(
            ShellRunTool.evaluate_risk(&ctx, &json!({"command": "git status"})).level,
            RiskLevel::Low
        );
        assert_eq!(
            ShellRunTool.evaluate_risk(&ctx, &json!({"command": "rm -rf /"})).level,
            RiskLevel::Blocked
        );
    }
}
