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

/// Time a process group gets to exit after SIGTERM before it is force-killed.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Upper bound for draining output after the tracked shell exits. Detached
/// grandchildren may keep the pipes open forever, so never wait for EOF blindly.
const READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Default)]
pub struct ProcessManager {
    processes: Mutex<HashMap<String, ManagedProcess>>,
}

struct ManagedProcess {
    command: String,
    cwd: PathBuf,
    child: Option<Child>,
    /// Process-group id of the spawned shell (Unix); the shell leads its own group.
    pgid: Option<u32>,
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    stdout_reader: Option<tokio::task::JoinHandle<()>>,
    stderr_reader: Option<tokio::task::JoinHandle<()>>,
    started: Instant,
    exit_code: Option<i32>,
    killed: bool,
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        // `kill_on_drop` only reaches the shell; also take down its descendants.
        if self.child.is_some() {
            signal_group(self.pgid, GroupSignal::Kill);
        }
        for reader in [self.stdout_reader.take(), self.stderr_reader.take()]
            .into_iter()
            .flatten()
        {
            reader.abort();
        }
    }
}

#[derive(Clone, Copy)]
enum GroupSignal {
    Terminate,
    Kill,
}

/// Signals every process in the group. Returns false when nothing was signalled.
#[cfg(unix)]
fn signal_group(pgid: Option<u32>, signal: GroupSignal) -> bool {
    let Some(pgid) = pgid.and_then(|pgid| libc::pid_t::try_from(pgid).ok()) else {
        return false;
    };
    if pgid <= 1 {
        return false;
    }
    let signal = match signal {
        GroupSignal::Terminate => libc::SIGTERM,
        GroupSignal::Kill => libc::SIGKILL,
    };
    // SAFETY: killpg only sends a signal to the group miniQ created for this process.
    unsafe { libc::killpg(pgid, signal) == 0 }
}

#[cfg(not(unix))]
fn signal_group(_pgid: Option<u32>, _signal: GroupSignal) -> bool {
    false
}

#[cfg(unix)]
fn group_alive(pgid: Option<u32>) -> bool {
    let Some(pgid) = pgid.and_then(|pgid| libc::pid_t::try_from(pgid).ok()) else {
        return false;
    };
    // SAFETY: signal 0 performs only an existence/permission check.
    pgid > 1 && unsafe { libc::killpg(pgid, 0) == 0 }
}

#[cfg(not(unix))]
fn group_alive(_pgid: Option<u32>) -> bool {
    false
}

/// Force-stops a process group created by miniQ (used after foreground timeouts).
pub(crate) fn force_kill_group(pgid: Option<u32>) {
    signal_group(pgid, GroupSignal::Kill);
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
        // Give the shell its own process group so killing it also stops the
        // programs it launched (e.g. `cd dir && python -m http.server`).
        #[cfg(unix)]
        child.process_group(0);
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
                pgid: pid,
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
        let pgid = {
            let mut processes = self.processes.lock().await;
            let process = processes.get_mut(id).ok_or_else(|| {
                ToolError::InvalidInput(format!("unknown background process: {id}"))
            })?;
            let running = match process.child.as_mut() {
                Some(child) => child
                    .try_wait()
                    .map_err(|error| ToolError::ExecutionFailed(format!("wait: {error}")))?
                    .is_none(),
                None => false,
            };
            // Descendants may outlive an already-exited shell; stop them too.
            if running || group_alive(process.pgid) {
                process.killed = true;
                Some(process.pgid)
            } else {
                None
            }
        };
        if let Some(pgid) = pgid {
            signal_group(pgid, GroupSignal::Terminate);
            let deadline = Instant::now() + KILL_GRACE;
            while group_alive(pgid) && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            signal_group(pgid, GroupSignal::Kill);
            let mut processes = self.processes.lock().await;
            if let Some(child) = processes.get_mut(id).and_then(|p| p.child.as_mut()) {
                // Fallback for platforms without process groups; waits for the shell.
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill().await;
                }
            }
        }
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
        let deadline = tokio::time::Instant::now() + READER_DRAIN_TIMEOUT;
        for mut reader in [stdout_reader, stderr_reader].into_iter().flatten() {
            if tokio::time::timeout_at(deadline, &mut reader)
                .await
                .is_err()
            {
                // A detached descendant still holds the pipe open; keep what we have.
                reader.abort();
            }
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
        "Read the complete result and status of a managed background process or child agent using its returned id/agentId. Use block=true with a bounded timeout when waiting, after launching other independent work; avoid rapid polling. A running status is not completion."
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

    /// Regression: `cd dir && server` leaves the server as a grandchild holding
    /// the stdout pipe. Killing only `sh` used to hang process_kill forever.
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_stops_descendants_and_returns_promptly() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ProcessManager::default();
        let started = manager
            .start(
                "printf ready; sleep 30 & wait".into(),
                dir.path().to_path_buf(),
                BTreeMap::new(),
            )
            .await
            .unwrap();
        let id = started["shellId"].as_str().unwrap().to_string();
        let pgid = started["pid"].as_u64().map(|pid| pid as u32);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !manager.output(&id, false, Duration::ZERO).await.unwrap()["stdout"]
            .as_str()
            .is_some_and(|stdout| stdout.contains("ready"))
        {
            assert!(Instant::now() < deadline, "process never became ready");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let killed = tokio::time::timeout(Duration::from_secs(10), manager.kill(&id))
            .await
            .expect("process_kill must not hang")
            .unwrap();
        assert_eq!(killed["status"], "killed");
        assert!(killed["stdout"].as_str().unwrap().contains("ready"));
        assert!(!group_alive(pgid), "descendants must be stopped");
    }

    /// A shell that exits while a detached child keeps the pipe open must still
    /// report completion instead of blocking process_output.
    #[cfg(unix)]
    #[tokio::test]
    async fn output_completes_when_descendant_keeps_pipe_open() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ProcessManager::default();
        let started = manager
            .start(
                "printf done; sleep 30 &".into(),
                dir.path().to_path_buf(),
                BTreeMap::new(),
            )
            .await
            .unwrap();
        let id = started["shellId"].as_str().unwrap().to_string();
        let pgid = started["pid"].as_u64().map(|pid| pid as u32);
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            manager.output(&id, true, Duration::from_secs(5)),
        )
        .await
        .expect("process_output must not hang")
        .unwrap();
        assert_eq!(output["status"], "completed");
        assert!(output["stdout"].as_str().unwrap().contains("done"));
        // The lingering descendant can still be cleaned up explicitly.
        let killed = tokio::time::timeout(Duration::from_secs(10), manager.kill(&id))
            .await
            .expect("process_kill must not hang")
            .unwrap();
        assert_eq!(killed["status"], "killed");
        assert!(!group_alive(pgid));
    }
}
