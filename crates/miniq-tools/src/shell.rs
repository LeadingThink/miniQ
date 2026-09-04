//! shell_run: execute a command inside the workspace cwd.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{classify_command, resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::router::{parse_input, Tool, ToolContext, ToolError};

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 600;

#[cfg(windows)]
const SHELL_DESCRIPTION: &str =
    "Run a Windows PowerShell command with the workspace root as working directory. \
     PowerShell runs without profiles and without interactive input. Returns exit code, stdout and stderr.";
#[cfg(not(windows))]
const SHELL_DESCRIPTION: &str =
    "Run a POSIX shell command with the workspace root as working directory. \
     Returns exit code, stdout and stderr.";

pub struct ShellRunTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShellRunInput {
    command: String,
    #[serde(default)]
    timeout_secs: Option<u64>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    run_in_background: bool,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[async_trait]
impl Tool for ShellRunTool {
    fn name(&self) -> &str {
        "shell_run"
    }
    fn description(&self) -> &str {
        SHELL_DESCRIPTION
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Command line to execute"},
                "timeoutSecs": {"type": "integer", "minimum": 1, "maximum": 600, "description": "Timeout in seconds (default 60, max 600)"},
                "cwd": {"type": "string", "description": "Working directory relative to the workspace root"}
                ,"runInBackground": {"type": "boolean", "description": "Start a managed process and return a shellId immediately"},
                "env": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Environment variables added to the child process"}
            },
            "required": ["command"],
            "additionalProperties": false
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        let Some(command) = input.get("command").and_then(|c| c.as_str()) else {
            return Risk {
                level: RiskLevel::Blocked,
                reason: "missing command".into(),
            };
        };
        if let Some(cwd) = input.get("cwd").and_then(Value::as_str) {
            if let Err(error) = resolve_in_workspace(&ctx.workspace, cwd) {
                return Risk {
                    level: RiskLevel::Blocked,
                    reason: error.to_string(),
                };
            }
        }
        classify_command(command)
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: ShellRunInput = parse_input(input)?;
        let timeout = p.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
        if !(1..=MAX_TIMEOUT_SECS).contains(&timeout) {
            return Err(ToolError::InvalidInput(
                "timeoutSecs must be between 1 and 600".into(),
            ));
        }

        let cwd = match p.cwd.as_deref() {
            Some(cwd) => resolve_in_workspace(&ctx.workspace, cwd)
                .map_err(|error| ToolError::SandboxDenied(error.to_string()))?,
            None => ctx.workspace.clone(),
        };
        if !cwd.is_dir() {
            return Err(ToolError::InvalidInput(format!(
                "cwd is not a directory: {}",
                cwd.display()
            )));
        }

        if p.run_in_background {
            return ctx.processes.start(p.command, cwd, p.env).await;
        }

        let mut cmd = shell_command(&p.command);
        cmd.current_dir(&cwd)
            .envs(&p.env)
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
                "cwd": cwd,
                "exitCode": output.status.code(),
                "stdout": String::from_utf8_lossy(&output.stdout),
                "stderr": String::from_utf8_lossy(&output.stderr),
                "durationMs": duration_ms,
                "timedOut": false,
            })),
            Ok(Err(e)) => Err(ToolError::ExecutionFailed(format!("wait: {e}"))),
            Err(_elapsed) => Ok(json!({
                "command": p.command,
                "cwd": cwd,
                "exitCode": null,
                "stdout": "",
                "stderr": format!("command timed out after {timeout}s"),
                "durationMs": duration_ms,
                "timedOut": true,
            })),
        }
    }
}

pub struct ShellBatchTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShellBatchInput {
    commands: Vec<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_output_length: Option<usize>,
    #[serde(default)]
    working_directory: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[async_trait]
impl Tool for ShellBatchTool {
    fn name(&self) -> &str {
        "shell_batch"
    }

    fn description(&self) -> &str {
        "Run one or more non-interactive shell commands sequentially in the local workspace."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "commands": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 600000},
                "maxOutputLength": {"type": "integer", "minimum": 1},
                "workingDirectory": {"type": "string"},
                "env": {"type": "object", "additionalProperties": {"type": "string"}}
            },
            "required": ["commands"],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        let Some(commands) = input.get("commands").and_then(Value::as_array) else {
            return blocked("commands must be a non-empty array");
        };
        if commands.is_empty() {
            return blocked("commands must be a non-empty array");
        }
        if commands.iter().any(|command| {
            command
                .as_str()
                .is_none_or(|command| command.trim().is_empty())
        }) {
            return blocked("commands must contain only non-empty strings");
        }
        if let Some(cwd) = input.get("workingDirectory").and_then(Value::as_str) {
            if let Err(error) = resolve_in_workspace(&ctx.workspace, cwd) {
                return blocked(&error.to_string());
            }
        }
        commands
            .iter()
            .map(|command| command.as_str().expect("commands validated as strings"))
            .map(classify_command)
            .max_by_key(|risk| risk_rank(risk.level))
            .expect("commands validated as non-empty")
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: ShellBatchInput = parse_input(input)?;
        if input.commands.is_empty()
            || input
                .commands
                .iter()
                .any(|command| command.trim().is_empty())
        {
            return Err(ToolError::InvalidInput(
                "commands must contain at least one non-empty command".into(),
            ));
        }
        let timeout_ms = input.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_SECS * 1000);
        if !(1..=MAX_TIMEOUT_SECS * 1000).contains(&timeout_ms) {
            return Err(ToolError::InvalidInput(
                "timeoutMs must be between 1 and 600000".into(),
            ));
        }
        let mut output = Vec::with_capacity(input.commands.len());
        for command in input.commands {
            let result = ShellRunTool
                .execute(
                    ctx,
                    json!({
                        "command": command,
                        "timeoutSecs": timeout_ms.div_ceil(1000),
                        "cwd": input.working_directory,
                        "env": input.env,
                    }),
                )
                .await?;
            let outcome = if result["timedOut"] == true {
                json!({"type":"timeout"})
            } else {
                json!({"type":"exit", "exit_code": result["exitCode"]})
            };
            output.push(json!({
                "stdout": result["stdout"],
                "stderr": result["stderr"],
                "outcome": outcome,
            }));
        }
        Ok(json!({
            "output": output,
            "maxOutputLength": input.max_output_length,
        }))
    }
}

fn risk_rank(level: RiskLevel) -> u8 {
    match level {
        RiskLevel::Low => 0,
        RiskLevel::Medium => 1,
        RiskLevel::High => 2,
        RiskLevel::Blocked => 3,
    }
}

fn blocked(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Blocked,
        reason: reason.into(),
    }
}

#[cfg(windows)]
pub(crate) fn shell_command(command: &str) -> tokio::process::Command {
    let utf8_command = format!(
        "$OutputEncoding = [Console]::OutputEncoding = \
         [System.Text.UTF8Encoding]::new($false); {command}\n\
         $__miniqSucceeded = $?; $__miniqExitCode = $LASTEXITCODE; \
         if (-not $__miniqSucceeded) {{ \
             if ($null -ne $__miniqExitCode -and $__miniqExitCode -ne 0) {{ \
                 exit $__miniqExitCode \
             }}; exit 1 \
         }}; exit 0"
    );
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &utf8_command,
    ]);
    cmd
}

#[cfg(not(windows))]
pub(crate) fn shell_command(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::RiskLevel;

    #[tokio::test]
    async fn runs_echo() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let out = ShellRunTool
            .execute(&ctx, json!({"command": "echo hello-miniq"}))
            .await
            .unwrap();
        assert_eq!(out["exitCode"], 0);
        assert!(out["stdout"].as_str().unwrap().contains("hello-miniq"));
    }

    #[tokio::test]
    async fn runs_in_contained_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let out = ShellRunTool
            .execute(&ctx, json!({"command": "pwd", "cwd": "nested"}))
            .await
            .unwrap();
        assert!(out["stdout"].as_str().unwrap().contains("nested"));
    }

    #[test]
    fn rejects_working_directory_outside_workspace_before_execution() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let risk = ShellRunTool.evaluate_risk(&ctx, &json!({"command": "pwd", "cwd": "../"}));
        assert_eq!(risk.level, RiskLevel::Blocked);
    }

    #[test]
    fn rejects_non_string_batch_commands_during_risk_evaluation() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let risk = ShellBatchTool.evaluate_risk(
            &ctx,
            &json!({"commands": ["echo safe", {"unexpected": true}]}),
        );
        assert_eq!(risk.level, RiskLevel::Blocked);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn runs_windows_powershell_with_utf8_output() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let out = ShellRunTool
            .execute(
                &ctx,
                json!({"command": "Write-Output 'miniq-中文'; Write-Output (Get-Location).Path"}),
            )
            .await
            .unwrap();

        assert_eq!(out["exitCode"], 0);
        let stdout = out["stdout"].as_str().unwrap();
        assert!(stdout.contains("miniq-中文"));
        assert!(stdout.contains(dir.path().to_string_lossy().as_ref()));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn preserves_native_windows_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let out = ShellRunTool
            .execute(&ctx, json!({"command": "cmd.exe /C exit 7"}))
            .await
            .unwrap();

        assert_eq!(out["exitCode"], 7);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn reports_powershell_failure_after_native_success() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let out = ShellRunTool
            .execute(
                &ctx,
                json!({"command": "cmd.exe /C exit 0; Write-Error 'failed'"}),
            )
            .await
            .unwrap();

        assert_eq!(out["exitCode"], 1);
        assert!(out["stderr"].as_str().unwrap().contains("failed"));
    }

    #[cfg(windows)]
    #[test]
    fn description_identifies_windows_powershell() {
        assert!(ShellRunTool.description().contains("Windows PowerShell"));
    }

    #[test]
    fn risk_delegates_to_classifier() {
        let ctx = ToolContext::new(std::path::PathBuf::from("."));
        assert_eq!(
            ShellRunTool
                .evaluate_risk(&ctx, &json!({"command": "git status"}))
                .level,
            RiskLevel::Low
        );
        assert_eq!(
            ShellRunTool
                .evaluate_risk(&ctx, &json!({"command": "rm -rf /"}))
                .level,
            RiskLevel::Blocked
        );
    }
}
