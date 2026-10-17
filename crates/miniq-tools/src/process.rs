//! Session-scoped managed processes with replayable disk output and optional PTY.
mod interaction;
mod output;
mod pty;
mod tools;
pub use tools::{ProcessInputTool, ProcessKillTool, ProcessOutputTool, ProcessResizeTool};

use crate::{ToolContext, ToolError};
use output::{Output, Spool};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, ChildStdin},
    sync::Mutex,
};

#[derive(Default)]
pub struct ProcessManager {
    processes: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

#[derive(Debug, Clone)]
pub struct TerminalLaunch {
    pub command: String,
    pub cwd: PathBuf,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Copy)]
pub struct TerminalOutputRequest {
    pub stdout_offset: Option<u64>,
    pub max_bytes: usize,
    pub wait: Duration,
}
struct ManagedProcess {
    owner: String,
    command: String,
    cwd: PathBuf,
    runtime: Mutex<Runtime>,
    input: Mutex<Option<ChildStdin>>,
    stdout: Output,
    stderr: Output,
    cursor: Mutex<(u64, u64)>,
    started: Instant,
    pgid: Option<u32>,
    readers: Vec<tokio::task::JoinHandle<()>>,
    tty: bool,
}
struct Runtime {
    child: ProcessChild,
    exit_code: Option<i32>,
    killed: bool,
    elapsed_ms: Option<u64>,
}
enum ProcessChild {
    Pipe(Child),
    Terminal(pty::Terminal),
}

pub(crate) struct Launch {
    pub command: String,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub interactive: bool,
    pub tty: bool,
    pub rows: u16,
    pub cols: u16,
}
#[derive(Clone, Copy)]
pub(crate) struct PageRequest {
    pub stdout_offset: Option<u64>,
    pub stderr_offset: Option<u64>,
    pub max_bytes: usize,
    pub raw: bool,
}
impl Default for PageRequest {
    fn default() -> Self {
        Self {
            stdout_offset: None,
            stderr_offset: None,
            max_bytes: 16_384,
            raw: false,
        }
    }
}
impl Drop for ManagedProcess {
    fn drop(&mut self) {
        if self.runtime.get_mut().exit_code.is_none()
            || !self.stdout.lock().unwrap().closed
            || !self.stderr.lock().unwrap().closed
        {
            force_kill_group(self.pgid);
        }
        for reader in &self.readers {
            reader.abort();
        }
    }
}
fn scope(ctx: &ToolContext) -> String {
    format!(
        "{}:{}",
        ctx.task_scope,
        ctx.agents
            .as_ref()
            .and_then(|a| a.owner_agent_id())
            .unwrap_or("root")
    )
}

fn terminal_context(owner: &str, cwd: PathBuf) -> ToolContext {
    let mut context = ToolContext::new(cwd);
    context.task_scope = format!("terminal:{owner}");
    context
}
fn failure(error: impl std::fmt::Display) -> ToolError {
    ToolError::ExecutionFailed(format!("process: {error}"))
}

impl ProcessManager {
    pub async fn terminal_start(
        &self,
        owner: &str,
        launch: TerminalLaunch,
    ) -> Result<String, ToolError> {
        let context = terminal_context(owner, launch.cwd.clone());
        self.start(
            &context,
            Launch {
                command: launch.command,
                cwd: launch.cwd,
                env: BTreeMap::new(),
                interactive: true,
                tty: true,
                rows: launch.rows,
                cols: launch.cols,
            },
        )
        .await
    }

    pub async fn terminal_output(
        &self,
        owner: &str,
        cwd: PathBuf,
        id: &str,
        request: TerminalOutputRequest,
    ) -> Result<Value, ToolError> {
        let context = terminal_context(owner, cwd);
        self.output_wait(
            &context,
            id,
            request.wait,
            PageRequest {
                stdout_offset: request.stdout_offset,
                stderr_offset: Some(0),
                max_bytes: request.max_bytes,
                raw: false,
            },
            true,
        )
        .await
    }

    pub async fn terminal_input(
        &self,
        owner: &str,
        cwd: PathBuf,
        id: &str,
        chars: String,
    ) -> Result<(), ToolError> {
        self.input(&terminal_context(owner, cwd), id, chars, false)
            .await
    }

    pub async fn terminal_resize(
        &self,
        owner: &str,
        cwd: PathBuf,
        id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<Value, ToolError> {
        self.resize(&terminal_context(owner, cwd), id, rows, cols)
            .await
    }

    pub async fn terminal_close(
        &self,
        owner: &str,
        cwd: PathBuf,
        id: &str,
    ) -> Result<Value, ToolError> {
        self.kill(&terminal_context(owner, cwd), id, PageRequest::default())
            .await
    }

    /// Stop every remaining job before the daemon runtime is torn down.
    pub async fn shutdown(&self) -> Result<(), ToolError> {
        let jobs = self
            .processes
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let results = futures_util::future::join_all(jobs.iter().map(|job| terminate(job))).await;
        self.processes.lock().await.clear();
        for result in results {
            result?;
        }
        Ok(())
    }
    pub(crate) async fn start(
        &self,
        ctx: &ToolContext,
        launch: Launch,
    ) -> Result<String, ToolError> {
        if ctx.cancellation.is_cancelled() {
            return Err(failure("cancelled before process start"));
        }
        let Launch {
            command,
            cwd,
            env,
            interactive,
            tty,
            rows,
            cols,
        } = launch;
        let (child, input, stdout, stderr, pgid, readers) = if tty {
            let command = command.clone();
            let cwd = cwd.clone();
            let (terminal, stdout, stderr) =
                tokio::task::spawn_blocking(move || pty::start(&command, &cwd, &env, rows, cols))
                    .await
                    .map_err(failure)??;
            let pid = terminal.pid;
            (
                ProcessChild::Terminal(terminal),
                None,
                stdout,
                stderr,
                pid,
                vec![],
            )
        } else {
            let stdout = Spool::new()?;
            let stderr = Spool::new()?;
            let mut cmd = crate::shell::shell_command(&command, interactive);
            cmd.current_dir(&cwd)
                .envs(env)
                .stdin(if interactive {
                    std::process::Stdio::piped()
                } else {
                    std::process::Stdio::null()
                })
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            #[cfg(unix)]
            cmd.process_group(0);
            let mut child = cmd.spawn().map_err(failure)?;
            let pid = child.id();
            let input = child.stdin.take();
            let readers = vec![
                collect(child.stdout.take().unwrap(), stdout.clone()),
                collect(child.stderr.take().unwrap(), stderr.clone()),
            ];
            (
                ProcessChild::Pipe(child),
                input,
                stdout,
                stderr,
                pid,
                readers,
            )
        };
        let id = miniq_memory::new_id("shell");
        let process = Arc::new(ManagedProcess {
            owner: scope(ctx),
            command,
            cwd,
            runtime: Mutex::new(Runtime {
                child,
                exit_code: None,
                killed: false,
                elapsed_ms: None,
            }),
            input: Mutex::new(input),
            stdout,
            stderr,
            cursor: Mutex::new((0, 0)),
            started: Instant::now(),
            pgid,
            readers,
            tty,
        });
        if ctx.cancellation.is_cancelled() {
            drop(process);
            return Err(failure("cancelled during process start"));
        }
        self.processes
            .lock()
            .await
            .insert(id.clone(), process.clone());
        // Long-lived jobs outlive a tool call, but never outlive its owning turn's cancellation.
        let cancel = ctx.cancellation.clone();
        let weak = Arc::downgrade(&process);
        tokio::spawn(async move {
            loop {
                let Some(process) = weak.upgrade() else {
                    break;
                };
                tokio::select! {
                    _ = cancel.cancelled() => { let _ = terminate(&process).await; break; }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {
                        let running = refresh(&process).await.unwrap_or(false);
                        if !running && process.stdout.lock().unwrap().closed && process.stderr.lock().unwrap().closed { break; }
                    }
                }
            }
        });
        Ok(id)
    }
    async fn owned(&self, ctx: &ToolContext, id: &str) -> Result<Arc<ManagedProcess>, ToolError> {
        self.processes
            .lock()
            .await
            .get(id)
            .filter(|p| p.owner == scope(ctx))
            .cloned()
            .ok_or_else(|| ToolError::InvalidInput("unknown process in this session/agent".into()))
    }
    pub(crate) async fn output(
        &self,
        ctx: &ToolContext,
        id: &str,
        wait: Duration,
        page: PageRequest,
    ) -> Result<Value, ToolError> {
        self.output_wait(ctx, id, wait, page, false).await
    }
    async fn output_wait(
        &self,
        ctx: &ToolContext,
        id: &str,
        wait: Duration,
        page: PageRequest,
        return_on_output: bool,
    ) -> Result<Value, ToolError> {
        let process = self.owned(ctx, id).await?;
        // Waiting callers serialize only delivery, not the whole wait interval.
        let start = {
            let cursor = process.cursor.lock().await;
            (
                page.stdout_offset.unwrap_or(cursor.0),
                page.stderr_offset.unwrap_or(cursor.1),
            )
        };
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let running = refresh(&process).await?;
            let stdout_ready = process.stdout.lock().unwrap().len > start.0;
            let stderr_ready = process.stderr.lock().unwrap().len > start.1;
            if !running
                || (return_on_output && (stdout_ready || stderr_ready))
                || tokio::time::Instant::now() >= deadline
            {
                break;
            }
            tokio::select! {
                _ = ctx.cancellation.cancelled() => return Err(failure("cancelled while waiting")),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
        }
        // Let queued readers finish after process exit, bounded for inherited open pipes.
        if process.runtime.lock().await.exit_code.is_some() {
            let drain = tokio::time::Instant::now() + Duration::from_millis(500);
            while !(process.stdout.lock().unwrap().closed && process.stderr.lock().unwrap().closed)
                && tokio::time::Instant::now() < drain
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        let mut cursor = process.cursor.lock().await;
        let start = (
            page.stdout_offset.unwrap_or(cursor.0.max(start.0)),
            page.stderr_offset.unwrap_or(cursor.1.max(start.1)),
        );
        let mut stdout = process
            .stdout
            .lock()
            .unwrap()
            .page(start.0, page.max_bytes, page.raw)?;
        let mut stderr = process
            .stderr
            .lock()
            .unwrap()
            .page(start.1, page.max_bytes, page.raw)?;
        if page.stdout_offset.is_none() {
            cursor.0 = stdout["nextOffset"].as_u64().unwrap();
        }
        if page.stderr_offset.is_none() {
            cursor.1 = stderr["nextOffset"].as_u64().unwrap();
        }
        let runtime = process.runtime.lock().await;
        let status = if runtime.killed {
            "killed"
        } else {
            match runtime.exit_code {
                None => "running",
                Some(0) => "completed",
                _ => "failed",
            }
        };
        let stdout_text = stdout
            .as_object_mut()
            .unwrap()
            .remove("text")
            .unwrap_or(Value::Null);
        let stderr_text = stderr
            .as_object_mut()
            .unwrap()
            .remove("text")
            .unwrap_or(Value::Null);
        let has_more = stdout["hasMore"] == true || stderr["hasMore"] == true;
        let mut result = json!({"shellId":id,"session_id":id,"taskId":id,"pid":process.pgid,
            "command":process.command,"cwd":process.cwd,"tty":process.tty,"status":status,
            "exitCode":runtime.exit_code,"ok":(status == "running" || status == "completed") && stdout["error"].is_null() && stderr["error"].is_null(),
            "stdout":stdout_text,"stderr":stderr_text,"stdoutPage":stdout,"stderrPage":stderr,
            "archiveRef":{"processId":id,"tool":"process_output","stdoutOffset":stdout["nextOffset"],"stderrOffset":stderr["nextOffset"]},
            "outputPending":!stdout["closed"].as_bool().unwrap_or(false) || !stderr["closed"].as_bool().unwrap_or(false),
            "hasMore":has_more,
            "durationMs":runtime.elapsed_ms.unwrap_or_else(|| process.started.elapsed().as_millis() as u64)});
        if has_more {
            result["outputNotice"] = "PARTIAL OUTPUT: unread bytes remain. Use nextPage before claiming the entire output was inspected.".into();
            result["nextPage"] = json!({"tool":"process_output","arguments":{"id":id,
                "stdoutOffset":stdout["nextOffset"],"stderrOffset":stderr["nextOffset"],"raw":page.raw}});
        }
        Ok(result)
    }
    pub(crate) async fn kill(
        &self,
        ctx: &ToolContext,
        id: &str,
        page: PageRequest,
    ) -> Result<Value, ToolError> {
        let process = self.owned(ctx, id).await?;
        terminate(&process).await?;
        self.output(ctx, id, Duration::ZERO, page).await
    }
}
async fn refresh(process: &ManagedProcess) -> Result<bool, ToolError> {
    let mut runtime = process.runtime.lock().await;
    if runtime.exit_code.is_some() {
        return Ok(false);
    }
    runtime.exit_code = match &mut runtime.child {
        ProcessChild::Pipe(child) => child
            .try_wait()
            .map_err(failure)?
            .map(|s| s.code().unwrap_or(-1)),
        ProcessChild::Terminal(child) => child
            .child
            .try_wait()
            .map_err(failure)?
            .map(|s| s.exit_code() as i32),
    };
    if runtime.exit_code.is_some() {
        runtime.elapsed_ms = Some(process.started.elapsed().as_millis() as u64);
    }
    Ok(runtime.exit_code.is_none())
}
async fn terminate(process: &ManagedProcess) -> Result<(), ToolError> {
    let running = refresh(process).await?;
    if !running && process.stdout.lock().unwrap().closed && process.stderr.lock().unwrap().closed {
        return Ok(());
    }
    #[cfg(windows)]
    if let Some(pid) = process.pgid {
        // Pipe processes also need descendant cleanup; ConPTY closure alone is
        // not a portable guarantee for detached grandchildren.
        let status = tokio::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map_err(failure)?;
        if !status.success() && refresh(process).await? {
            return Err(failure("could not stop Windows process tree"));
        }
    }
    #[cfg(unix)]
    if let Some(pid) = process.pgid {
        unsafe {
            libc::killpg(pid as i32, libc::SIGTERM);
        }
    }
    force_kill_group(process.pgid);
    let mut runtime = process.runtime.lock().await;
    runtime.killed = true;
    match &mut runtime.child {
        ProcessChild::Pipe(child) => {
            if child.try_wait().map_err(failure)?.is_none() {
                child.start_kill().map_err(failure)?;
            }
        }
        ProcessChild::Terminal(child) => {
            let _ = child.child.kill();
        }
    }
    drop(runtime);
    refresh(process).await?;
    Ok(())
}
pub(crate) fn force_kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()).filter(|p| *p > 1) {
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}
fn collect<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    output: Output,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut bytes = [0; 8192];
        loop {
            match reader.read(&mut bytes).await {
                Ok(0) => break,
                Ok(n) => {
                    let error = output.lock().unwrap().append(&bytes[..n]).err();
                    if let Some(error) = error {
                        output.lock().unwrap().error = Some(error.to_string());
                        break;
                    }
                }
                Err(error) => {
                    output.lock().unwrap().error = Some(error.to_string());
                    break;
                }
            }
        }
        output.lock().unwrap().closed = true;
    })
}
#[cfg(test)]
mod tests;
