//! shell_run: execute a command inside the workspace cwd.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{classify_command, Risk};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::router::{parse_input, Tool, ToolContext, ToolError};

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 600;

fn command_error_code(stderr: &str) -> Option<&'static str> {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("is not recognized as the name of a cmdlet")
        || lower.contains("is not recognized as a name of a cmdlet")
        || lower.contains("is not recognized as an internal or external command")
        || lower.contains("command not found")
        || lower.contains(": not found")
    {
        Some("COMMAND_NOT_FOUND")
    } else {
        None
    }
}

#[cfg(windows)]
const SHELL_DESCRIPTION: &str =
    "Run a Windows PowerShell command with the workspace root as working directory. \
     PowerShell runs without profiles. interactive=true keeps pipe stdin; tty=true creates a PTY/ConPTY. \
     yieldTimeMs returns a running handle after a bounded wait; timeoutSecs is the one-shot deadline. \
     Output is paginated and retained for process_output replay while the daemon lives. Returns ok, exit code, stdout and stderr; \
     a non-zero exit is a failed observation.";
#[cfg(not(windows))]
const SHELL_DESCRIPTION: &str =
    "Run a POSIX shell command with the workspace root as working directory. \
     interactive=true keeps pipe stdin; tty=true creates a PTY. yieldTimeMs returns a running \
     handle after a bounded wait; timeoutSecs is the one-shot deadline. Output is paginated \
     and retained for process_output replay while the daemon lives. \
     Returns ok, exit code, stdout and stderr; a non-zero exit is a failed observation.";

pub struct ShellRunTool;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShellRunInput {
    command: String,
    #[serde(default)]
    #[schemars(range(min = 1, max = 600))]
    timeout_secs: Option<u64>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    run_in_background: bool,
    /// Return a running handle instead of killing the process when this wait expires.
    #[serde(default)]
    #[schemars(range(min = 0, max = 600000))]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    interactive: bool,
    #[serde(default)]
    tty: bool,
    #[serde(default)]
    #[schemars(range(min = 1, max = 1000))]
    rows: Option<u16>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 1000))]
    cols: Option<u16>,
    /// Estimated output budget (4 bytes per token per stream); remainder is paginated.
    #[serde(default)]
    #[schemars(range(min = 1, max = 65536))]
    max_output_tokens: Option<usize>,
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
        serde_json::to_value(schemars::schema_for!(ShellRunInput)).unwrap()
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        let Some(command) = input.get("command").and_then(|c| c.as_str()) else {
            return Risk {
                level: RiskLevel::Blocked,
                reason: "missing command".into(),
            };
        };
        if let Some(cwd) = input.get("cwd").and_then(Value::as_str) {
            if let Err(error) = ctx.resolve_path(cwd) {
                return Risk {
                    level: RiskLevel::Blocked,
                    reason: error.to_string(),
                };
            }
        }
        if input.get("interactive") == Some(&json!(true)) || input.get("tty") == Some(&json!(true))
        {
            let risk = classify_command(command);
            return if risk.level == RiskLevel::Blocked {
                risk
            } else {
                Risk {
                    level: RiskLevel::High,
                    reason: "starts an interactive process; later input can execute commands"
                        .into(),
                }
            };
        }
        classify_command(command)
    }
    fn approval_scope(&self, _ctx: &ToolContext, input: &Value) -> Option<String> {
        // A previous read-only program grant must not authorize a writable
        // shell/PTY. Bind interactive launch approval to the exact command.
        if input.get("interactive") == Some(&json!(true)) || input.get("tty") == Some(&json!(true))
        {
            Some(format!(
                "interactive:{}:{}",
                input["tty"] == true,
                input["command"].as_str().unwrap_or("")
            ))
        } else {
            None
        }
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
            Some(cwd) => ctx
                .resolve_path(cwd)
                .map_err(|error| ToolError::SandboxDenied(error.to_string()))?,
            None => ctx.workspace.clone(),
        };
        if !cwd.is_dir() {
            return Err(ToolError::InvalidInput(format!(
                "cwd is not a directory: {}",
                cwd.display()
            )));
        }

        if p.command.trim().is_empty()
            || p.yield_time_ms.is_some_and(|v| v > 600000)
            || p.max_output_tokens
                .is_some_and(|v| !(1..=65536).contains(&v))
            || p.rows.is_some_and(|v| !(1..=1000).contains(&v))
            || p.cols.is_some_and(|v| !(1..=1000).contains(&v))
            || (p.timeout_secs.is_some()
                && (p.yield_time_ms.is_some() || p.run_in_background || p.interactive || p.tty))
            || (!p.tty && (p.rows.is_some() || p.cols.is_some()))
        {
            return Err(ToolError::InvalidInput(
                "invalid command, wait, output budget or terminal size".into(),
            ));
        }
        let resumable = p.run_in_background || p.yield_time_ms.is_some() || p.interactive || p.tty;
        let wait = if p.run_in_background {
            0
        } else {
            p.yield_time_ms
                .unwrap_or(if resumable { 1000 } else { timeout * 1000 })
        };
        let page = crate::process::PageRequest {
            max_bytes: p.max_output_tokens.unwrap_or(4096) * 4,
            ..Default::default()
        };
        let id = ctx
            .processes
            .start(
                ctx,
                crate::process::Launch {
                    command: p.command,
                    cwd,
                    env: p.env,
                    interactive: p.interactive,
                    tty: p.tty,
                    rows: p.rows.unwrap_or(24),
                    cols: p.cols.unwrap_or(80),
                },
            )
            .await?;
        let mut result = ctx
            .processes
            .output(ctx, &id, std::time::Duration::from_millis(wait), page)
            .await?;
        if !resumable && result["status"] == "running" {
            // Preserve timeout output in the spool and return its first page.
            result = ctx
                .processes
                .kill(
                    ctx,
                    &id,
                    crate::process::PageRequest {
                        stdout_offset: Some(0),
                        stderr_offset: Some(0),
                        ..page
                    },
                )
                .await?;
            result["timedOut"] = json!(true);
            result["ok"] = json!(false);
            result["errorCode"] = json!("TIMEOUT");
        } else {
            result["timedOut"] = json!(false);
            if result["ok"] == false {
                if let Some(code) =
                    command_error_code(result["stderr"].as_str().unwrap_or_default())
                {
                    result["errorCode"] = json!(code);
                }
            }
        }
        Ok(result)
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
        "Run one or more non-interactive shell commands sequentially in the local workspace. \
         Each result includes ok; if any command is not ok, do not repeat it unchanged."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "commands": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 600000},
                "maxOutputLength": {"type": "integer", "minimum": 1, "maximum": 262144, "description": "Approximate output page size in bytes per stream (rounded up to a 4-byte budget); remainder stays available through archiveRef"},
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
            if let Err(error) = ctx.resolve_path(cwd) {
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
        if input
            .max_output_length
            .is_some_and(|n| n == 0 || n > 262144)
        {
            return Err(ToolError::InvalidInput(
                "maxOutputLength must be 1..262144 bytes per stream".into(),
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
                    "maxOutputTokens": input.max_output_length.map(|bytes| bytes.div_ceil(4)),
                    "cwd": input.working_directory,
                        "env": input.env,
                    }),
                )
                .await?;
            let ok = result["ok"] == true;
            let outcome = if result["timedOut"] == true {
                json!({"type":"timeout"})
            } else {
                json!({"type":"exit", "exit_code": result["exitCode"]})
            };
            let mut entry = result;
            entry["outcome"] = outcome;
            entry["ok"] = json!(ok);
            output.push(entry);
        }
        let ok = output.iter().all(|entry| entry["ok"] == true);
        Ok(json!({
            "output": output,
            "maxOutputLength": input.max_output_length,
            "ok": ok,
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
pub(crate) fn shell_command(command: &str, interactive: bool) -> tokio::process::Command {
    // Flush PowerShell's deferred object formatting before exiting, retaining command status.
    let utf8_command = format!(
        "$OutputEncoding = [Console]::OutputEncoding = \
         [System.Text.UTF8Encoding]::new($false); & {{ {command}\n\
         $script:__miniqSucceeded = $?; $script:__miniqExitCode = $LASTEXITCODE \
         }} | Out-Default; \
         if (-not $__miniqSucceeded) {{ \
             if ($null -ne $__miniqExitCode -and $__miniqExitCode -ne 0) {{ \
                 exit $__miniqExitCode \
             }}; exit 1 \
         }}; exit 0"
    );
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile"]);
    if !interactive {
        cmd.arg("-NonInteractive");
    }
    cmd.args(["-Command", &utf8_command]);
    cmd
}

#[cfg(not(windows))]
pub(crate) fn shell_command(command: &str, _interactive: bool) -> tokio::process::Command {
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
        assert_eq!(out["ok"], true);
        assert!(out["stdout"].as_str().unwrap().contains("hello-miniq"));
    }

    #[tokio::test]
    async fn marks_nonzero_exit_as_failed_observation() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let command = if cfg!(windows) {
            "cmd.exe /C exit 7"
        } else {
            "exit 7"
        };
        let out = ShellRunTool
            .execute(&ctx, json!({"command": command}))
            .await
            .unwrap();
        assert_eq!(out["exitCode"], 7);
        assert_eq!(out["ok"], false);
    }

    #[tokio::test]
    async fn missing_commands_are_explicit_failures_in_a_batch() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let out = ShellBatchTool
            .execute(&ctx, json!({"commands":["miniq_missing_command_12345"]}))
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["output"][0]["errorCode"], "COMMAND_NOT_FOUND");
        assert_eq!(out["output"][0]["ok"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_descendant_processes() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let marker = dir.path().join("pid");
        let out = ShellRunTool
            .execute(
                &ctx,
                json!({"command": format!("sleep 30 & echo $! > {}; wait", marker.display()), "timeoutSecs": 1}),
            )
            .await
            .unwrap();
        assert_eq!(out["timedOut"], true);
        let pid: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // SAFETY: signal 0 only checks whether the process still exists.
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "descendant survived timeout"
        );
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
        assert_eq!(out["exitCode"], 0);
        assert!(out["stdout"].as_str().unwrap().contains("nested"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn flushes_formatted_objects_before_exit() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let out = ShellRunTool
            .execute(
                &ctx,
                json!({"command": "1..3 | ForEach-Object { [pscustomobject]@{ Name = \"item-$_\" } }"}),
            )
            .await
            .unwrap();
        assert_eq!(out["exitCode"], 0);
        let stdout = out["stdout"].as_str().unwrap();
        for name in ["item-1", "item-2", "item-3"] {
            assert!(stdout.contains(name), "missing {name}: {stdout}");
        }
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
