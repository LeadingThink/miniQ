//! Managed background processes used by native Bash, TaskOutput and KillShell.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::router::{parse_input, Tool, ToolContext, ToolError};

#[derive(Default)]
pub struct ProcessManager {
    processes: Mutex<HashMap<String, ManagedProcess>>,
}

struct ManagedProcess {
    command: String,
    cwd: PathBuf,
    child: Option<Child>,
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    stdout_reader: Option<tokio::task::JoinHandle<()>>,
    stderr_reader: Option<tokio::task::JoinHandle<()>>,
    started: Instant,
    exit_code: Option<i32>,
    killed: bool,
}

impl ProcessManager {
    pub(crate) async fn start(
        &self,
        command: String,
        cwd: PathBuf,
        env: BTreeMap<String, String>,
    ) -> Result<Value, ToolError> {
        let mut child = crate::shell::shell_command(&command);
        child
            .current_dir(&cwd)
            .envs(env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = child
            .spawn()
            .map_err(|error| ToolError::ExecutionFailed(format!("spawn: {error}")))?;
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let stdout_reader = child
            .stdout
            .take()
            .map(|reader| collect_output(reader, stdout.clone()));
        let stderr_reader = child
            .stderr
            .take()
            .map(|reader| collect_output(reader, stderr.clone()));
        let id = miniq_memory::new_id("shell");
        let pid = child.id();
        self.processes.lock().await.insert(
            id.clone(),
            ManagedProcess {
                command: command.clone(),
                cwd: cwd.clone(),
                child: Some(child),
                stdout,
                stderr,
                stdout_reader,
                stderr_reader,
                started: Instant::now(),
                exit_code: None,
                killed: false,
            },
        );
        Ok(json!({
            "shellId": id,
            "taskId": id,
            "pid": pid,
            "command": command,
            "cwd": cwd,
            "status": "running",
        }))
    }

    pub async fn output(
        &self,
        id: &str,
        block: bool,
        timeout: Duration,
    ) -> Result<Value, ToolError> {
        let deadline = Instant::now() + timeout;
        loop {
            let running = self.refresh(id).await?;
            if !running || !block || Instant::now() >= deadline {
                return self.snapshot(id).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub async fn kill(&self, id: &str) -> Result<Value, ToolError> {
        let mut processes = self.processes.lock().await;
        let process = processes
            .get_mut(id)
            .ok_or_else(|| ToolError::InvalidInput(format!("unknown background process: {id}")))?;
        if let Some(child) = process.child.as_mut() {
            if child
                .try_wait()
                .map_err(|error| ToolError::ExecutionFailed(format!("wait: {error}")))?
                .is_none()
            {
                child
                    .kill()
                    .await
                    .map_err(|error| ToolError::ExecutionFailed(format!("kill: {error}")))?;
                process.killed = true;
            }
        }
        drop(processes);
        self.refresh(id).await?;
        self.snapshot(id).await
    }

    async fn refresh(&self, id: &str) -> Result<bool, ToolError> {
        let mut processes = self.processes.lock().await;
        let process = processes
            .get_mut(id)
            .ok_or_else(|| ToolError::InvalidInput(format!("unknown background process: {id}")))?;
        let Some(child) = process.child.as_mut() else {
            return Ok(false);
        };
        let status = child
            .try_wait()
            .map_err(|error| ToolError::ExecutionFailed(format!("wait: {error}")))?;
        let Some(status) = status else {
            return Ok(true);
        };
        process.exit_code = status.code();
        process.child = None;
        let stdout_reader = process.stdout_reader.take();
        let stderr_reader = process.stderr_reader.take();
        drop(processes);
        if let Some(reader) = stdout_reader {
            let _ = reader.await;
        }
        if let Some(reader) = stderr_reader {
            let _ = reader.await;
        }
        Ok(false)
    }

    async fn snapshot(&self, id: &str) -> Result<Value, ToolError> {
        let processes = self.processes.lock().await;
        let process = processes
            .get(id)
            .ok_or_else(|| ToolError::InvalidInput(format!("unknown background process: {id}")))?;
        let stdout = process.stdout.lock().await;
        let stderr = process.stderr.lock().await;
        let status = if process.child.is_some() {
            "running"
        } else if process.killed {
            "killed"
        } else if process.exit_code == Some(0) {
            "completed"
        } else {
            "failed"
        };
        Ok(json!({
            "shellId": id,
            "taskId": id,
            "command": process.command,
            "cwd": process.cwd,
            "status": status,
            "exitCode": process.exit_code,
            "stdout": String::from_utf8_lossy(&stdout),
            "stderr": String::from_utf8_lossy(&stderr),
            "durationMs": process.started.elapsed().as_millis() as u64,
        }))
    }
}

fn collect_output<R>(mut reader: R, output: Arc<Mutex<Vec<u8>>>) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut chunk = [0_u8; 8192];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => output.lock().await.extend_from_slice(&chunk[..read]),
            }
        }
    })
}

pub struct ProcessOutputTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessOutputInput {
    id: String,
    #[serde(default)]
    block: bool,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[async_trait]
impl Tool for ProcessOutputTool {
    fn name(&self) -> &str {
        "process_output"
    }

    fn description(&self) -> &str {
        "Read complete stdout, stderr and status from a managed background shell process."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "block": {"type": "boolean"},
                "timeoutSecs": {"type": "integer", "minimum": 1, "maximum": 600}
            },
            "required": ["id"],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk("reads output from a process started by miniQ")
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: ProcessOutputInput = parse_input(input)?;
        let timeout_secs = input.timeout_secs.unwrap_or(30);
        if !(1..=600).contains(&timeout_secs) {
            return Err(ToolError::InvalidInput(
                "timeoutSecs must be between 1 and 600".into(),
            ));
        }
        if input.id.starts_with("agent_") {
            return ctx
                .agents
                .as_ref()
                .ok_or_else(|| ToolError::ExecutionFailed("agent runtime is unavailable".into()))?
                .output(&input.id, input.block, Duration::from_secs(timeout_secs))
                .await;
        }
        ctx.processes
            .output(&input.id, input.block, Duration::from_secs(timeout_secs))
            .await
    }
}

pub struct ProcessKillTool;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessKillInput {
    id: String,
}

#[async_trait]
impl Tool for ProcessKillTool {
    fn name(&self) -> &str {
        "process_kill"
    }

    fn description(&self) -> &str {
        "Stop a managed background shell process started by miniQ."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "stops a process previously started by miniQ".into(),
        }
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: ProcessKillInput = parse_input(input)?;
        if input.id.starts_with("agent_") {
            return ctx
                .agents
                .as_ref()
                .ok_or_else(|| ToolError::ExecutionFailed("agent runtime is unavailable".into()))?
                .stop(&input.id)
                .await;
        }
        ctx.processes.kill(&input.id).await
    }
}

fn low_risk(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Low,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn background_process_can_be_polled_and_killed() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ProcessManager::default();
        #[cfg(windows)]
        let command = "Write-Output ready; Start-Sleep -Seconds 5";
        #[cfg(not(windows))]
        let command = "printf ready; sleep 5";
        let started = manager
            .start(command.into(), dir.path().to_path_buf(), BTreeMap::new())
            .await
            .unwrap();
        let id = started["shellId"].as_str().unwrap();
        let running = loop {
            let output = manager
                .output(id, false, Duration::from_secs(1))
                .await
                .unwrap();
            if output["stdout"]
                .as_str()
                .is_some_and(|stdout| stdout.contains("ready"))
            {
                break output;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(running["status"], "running");
        let killed = manager.kill(id).await.unwrap();
        assert_eq!(killed["status"], "killed");
        assert!(killed["stdout"].as_str().unwrap().contains("ready"));
    }
}
