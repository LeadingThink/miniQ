use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_protocol::{
    JsonRpcVersion, NodeHelloParams, NodeInitializeParams, NodePluginDaemonMethod,
    NodePluginHostMethod, NodePluginNotification, NodePluginRequest, NodePluginResponse,
    NodeToolCancelParams, NodeToolExecuteParams, NodeToolMetadata, NodeToolResultParams,
    NodeToolsRegisterParams, NODE_PLUGIN_PROTOCOL_VERSION,
};
use miniq_sandbox::Risk;
use miniq_tools::{RegistrationHandle, Tool, ToolContext, ToolError};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::{PluginError, PluginFailureKind, PluginLimits};
use crate::manifest::PluginManifest;

#[cfg(windows)]
struct ProcessJob {
    _handle: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl ProcessJob {
    fn assign(child: &Child) -> Result<Self, PluginError> {
        use std::ffi::c_void;
        use std::mem::size_of;
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(PluginError::new(
                PluginFailureKind::Process,
                format!(
                    "failed to create plugin process job: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned = configured != 0
            && unsafe { AssignProcessToJobObject(job, child.raw_handle().unwrap() as _) } != 0;
        if !assigned {
            let error = std::io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return Err(PluginError::new(
                PluginFailureKind::Process,
                format!("failed to contain plugin process: {error}"),
            ));
        }

        Ok(Self {
            _handle: unsafe { OwnedHandle::from_raw_handle(job) },
        })
    }
}

const HOST_SOURCE: &str = include_str!("../../../packages/node-plugin-host/dist/index.js");

pub(crate) struct NodePluginProcess {
    manifest: PluginManifest,
    stdin: AsyncMutex<ChildStdin>,
    child: AsyncMutex<Child>,
    responses: Arc<Mutex<HashMap<u64, oneshot::Sender<NodePluginResponse>>>>,
    notifications: broadcast::Sender<NodePluginNotification>,
    next_request_id: AtomicU64,
    limits: PluginLimits,
    semaphore: Semaphore,
    cancellation: CancellationToken,
    handles: Arc<Mutex<Vec<RegistrationHandle>>>,
    stopping: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
    #[cfg(windows)]
    _process_job: ProcessJob,
}

impl NodePluginProcess {
    pub(crate) async fn start(
        manifest: PluginManifest,
        plugin_dir: &Path,
        entry: &Path,
        limits: PluginLimits,
        handles: Arc<Mutex<Vec<RegistrationHandle>>>,
    ) -> Result<(Arc<Self>, Vec<NodeToolMetadata>), PluginError> {
        limits.validate()?;
        let node = find_node(&manifest).await?;
        install_host(plugin_dir)?;
        let host_entry = Path::new(".miniq-node-plugin-host-v1/host.mjs");
        let system_root = std::env::var("SystemRoot").unwrap_or_default();
        let system_drive = std::env::var("SystemDrive")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| system_root.get(..2).map(str::to_owned))
            .unwrap_or_default();
        let path = std::env::var("PATH").unwrap_or_default();
        let pathext = std::env::var("PATHEXT").unwrap_or_default();
        let comspec = std::env::var("COMSPEC").unwrap_or_default();
        let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
        let home_drive = std::env::var("HOMEDRIVE").unwrap_or_default();
        let home_path = std::env::var("HOMEPATH").unwrap_or_default();
        let mut command = Command::new(node);
        command
            .arg("--permission")
            .arg("--allow-fs-read=.")
            .arg(node_cli_path(host_entry))
            .current_dir(plugin_dir)
            .env_clear()
            .env("SystemRoot", system_root)
            .env("SystemDrive", system_drive)
            .env("PATH", path)
            .env("PATHEXT", pathext)
            .env("COMSPEC", comspec)
            .env("USERPROFILE", user_profile)
            .env("HOMEDRIVE", home_drive)
            .env("HOMEPATH", home_path)
            .env("TEMP", std::env::var("TEMP").unwrap_or_default())
            .env("TMP", std::env::var("TMP").unwrap_or_default())
            .env(
                "MINIQ_NODE_PLUGIN_PROTOCOL",
                NODE_PLUGIN_PROTOCOL_VERSION.to_string(),
            )
            .env("MINIQ_PLUGIN_ID", &manifest.id)
            .env("LANG", "C.UTF-8")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|error| PluginError::new(PluginFailureKind::Process, error.to_string()))?;
        #[cfg(windows)]
        let process_job = match ProcessJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error);
            }
        };
        let stdin = child.stdin.take().ok_or_else(|| {
            PluginError::new(PluginFailureKind::Process, "Node host stdin unavailable")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            PluginError::new(PluginFailureKind::Process, "Node host stdout unavailable")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            PluginError::new(PluginFailureKind::Process, "Node host stderr unavailable")
        })?;
        let (notifications, _) = broadcast::channel(limits.max_pending_requests * 4);
        let mut events = notifications.subscribe();
        let responses = Arc::new(Mutex::new(HashMap::new()));
        let cancellation = CancellationToken::new();
        let stopping = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(None));
        spawn_stdout_reader(
            stdout,
            responses.clone(),
            notifications.clone(),
            handles.clone(),
            cancellation.clone(),
            stopping.clone(),
            failure.clone(),
            limits.max_protocol_frame_bytes,
        );
        spawn_stderr_reader(stderr, manifest.id.clone(), limits.max_stderr_bytes);
        let process = Arc::new(Self {
            manifest,
            stdin: AsyncMutex::new(stdin),
            child: AsyncMutex::new(child),
            responses,
            notifications,
            next_request_id: AtomicU64::new(1),
            semaphore: Semaphore::new(limits.max_pending_requests),
            cancellation,
            handles,
            stopping,
            failure,
            limits,
            #[cfg(windows)]
            _process_job: process_job,
        });
        let hello = process
            .wait_for(
                &mut events,
                NodePluginHostMethod::Hello,
                process.limits.node_handshake_timeout,
            )
            .await?;
        let hello: NodeHelloParams = decode_params(hello.params)?;
        if hello.protocol_version != NODE_PLUGIN_PROTOCOL_VERSION {
            process.force_kill().await;
            return Err(PluginError::new(
                PluginFailureKind::Incompatible,
                "Node host protocol version mismatch",
            ));
        }
        let requirement = process
            .manifest
            .engine
            .as_ref()
            .expect("validated Node engine");
        let node_version = semver::Version::parse(&hello.node_version).map_err(|_| {
            PluginError::new(
                PluginFailureKind::Incompatible,
                "Node host returned an invalid version",
            )
        })?;
        if !requirement.node.matches(&node_version) {
            process.force_kill().await;
            return Err(PluginError::new(
                PluginFailureKind::Incompatible,
                format!(
                    "Node {} does not satisfy {}",
                    node_version, requirement.node
                ),
            ));
        }
        process
            .request(
                NodePluginDaemonMethod::Initialize,
                &NodeInitializeParams {
                    protocol_version: NODE_PLUGIN_PROTOCOL_VERSION,
                    plugin_id: process.manifest.id.clone(),
                    plugin_version: process.manifest.version.to_string(),
                    entry: entry.to_string_lossy().into_owned(),
                    max_frame_bytes: process.limits.max_protocol_frame_bytes as u32,
                    max_pending_requests: process.limits.max_pending_requests as u32,
                },
                process.limits.node_handshake_timeout,
            )
            .await?;
        process
            .request(
                NodePluginDaemonMethod::Activate,
                &json!({}),
                process.limits.node_handshake_timeout,
            )
            .await?;
        let mut metadata = Vec::new();
        loop {
            let event = process
                .wait_for_any(&mut events, process.limits.node_handshake_timeout)
                .await?;
            match event.method {
                NodePluginHostMethod::ToolsRegister => {
                    metadata.extend(decode_params::<NodeToolsRegisterParams>(event.params)?.tools)
                }
                NodePluginHostMethod::Activated => break,
                NodePluginHostMethod::Error => {
                    return Err(PluginError::new(
                        PluginFailureKind::Protocol,
                        event.params.to_string(),
                    ))
                }
                _ => {}
            }
        }
        if metadata.is_empty() {
            process.force_kill().await;
            return Err(PluginError::new(
                PluginFailureKind::InvalidMetadata,
                "Node plugin registered no tools",
            ));
        }
        Ok((process, metadata))
    }

    async fn request<T: Serialize>(
        &self,
        method: NodePluginDaemonMethod,
        params: &T,
        timeout: std::time::Duration,
    ) -> Result<Value, PluginError> {
        let _permit = self.semaphore.acquire().await.map_err(|_| {
            PluginError::new(PluginFailureKind::Cancelled, "Node plugin is stopping")
        })?;
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request = NodePluginRequest {
            jsonrpc: JsonRpcVersion::V2,
            id,
            method,
            params: serde_json::to_value(params).map_err(protocol_error)?,
        };
        let frame = serde_json::to_vec(&request).map_err(protocol_error)?;
        if frame.len() > self.limits.max_protocol_frame_bytes {
            return Err(PluginError::new(
                PluginFailureKind::ResourceLimit,
                "Node protocol frame exceeds configured limit",
            ));
        }
        let (sender, receiver) = oneshot::channel();
        self.responses.lock().unwrap().insert(id, sender);
        let write = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(&frame).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        if let Err(error) = write.await {
            self.responses.lock().unwrap().remove(&id);
            return Err(PluginError::new(
                PluginFailureKind::Process,
                error.to_string(),
            ));
        }
        let response = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                self.responses.lock().unwrap().remove(&id);
                return Err(PluginError::new(
                    PluginFailureKind::Process,
                    "Node host exited",
                ));
            }
            Err(_) => {
                self.responses.lock().unwrap().remove(&id);
                return Err(PluginError::new(
                    PluginFailureKind::Timeout,
                    "Node host request timed out",
                ));
            }
        };
        if let Some(error) = response.error {
            return Err(PluginError::new(PluginFailureKind::Protocol, error.message));
        }
        response.result.ok_or_else(|| {
            PluginError::new(
                PluginFailureKind::Protocol,
                "Node host response has no result",
            )
        })
    }

    pub(crate) async fn execute(
        &self,
        tool_name: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, PluginError> {
        let call_id = format!(
            "{}-{}",
            self.manifest.id,
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let mut events = self.notifications.subscribe();
        self.request(
            NodePluginDaemonMethod::ToolExecute,
            &NodeToolExecuteParams {
                call_id: call_id.clone(),
                tool_name: tool_name.to_string(),
                input,
            },
            self.limits.call_timeout,
        )
        .await?;
        let result = tokio::select! {
            result = self.wait_for_tool_result(&mut events, &call_id) => result,
            _ = cancel.cancelled() => {
                let _ = self.request(NodePluginDaemonMethod::ToolCancel, &NodeToolCancelParams { call_id: call_id.clone() }, self.limits.node_shutdown_timeout).await;
                Err(PluginError::new(PluginFailureKind::Cancelled, "Node tool call cancelled"))
            }
            _ = self.cancellation.cancelled() => Err(PluginError::new(PluginFailureKind::Cancelled, "Node plugin unloaded")),
        }?;
        if let Some(error) = result.error {
            return Err(PluginError::new(PluginFailureKind::Trap, error.message));
        }
        result.result.ok_or_else(|| {
            PluginError::new(PluginFailureKind::Protocol, "Node tool result is empty")
        })
    }

    async fn wait_for_tool_result(
        &self,
        events: &mut broadcast::Receiver<NodePluginNotification>,
        call_id: &str,
    ) -> Result<NodeToolResultParams, PluginError> {
        tokio::time::timeout(self.limits.call_timeout, async {
            loop {
                let event = events.recv().await.map_err(|_| {
                    PluginError::new(PluginFailureKind::Process, "Node host event stream closed")
                })?;
                if event.method == NodePluginHostMethod::ToolResult {
                    let result: NodeToolResultParams = decode_params(event.params)?;
                    if result.call_id == call_id {
                        return Ok(result);
                    }
                }
            }
        })
        .await
        .map_err(|_| {
            PluginError::new(PluginFailureKind::Timeout, "Node tool execution timed out")
        })?
    }

    async fn wait_for(
        &self,
        events: &mut broadcast::Receiver<NodePluginNotification>,
        method: NodePluginHostMethod,
        timeout: std::time::Duration,
    ) -> Result<NodePluginNotification, PluginError> {
        tokio::time::timeout(timeout, async {
            loop {
                let event = events.recv().await.map_err(|_| {
                    PluginError::new(PluginFailureKind::Process, "Node host event stream closed")
                })?;
                if event.method == method {
                    return Ok(event);
                }
            }
        })
        .await
        .map_err(|_| {
            PluginError::new(PluginFailureKind::Timeout, "Node host handshake timed out")
        })?
    }

    async fn wait_for_any(
        &self,
        events: &mut broadcast::Receiver<NodePluginNotification>,
        timeout: std::time::Duration,
    ) -> Result<NodePluginNotification, PluginError> {
        tokio::time::timeout(timeout, events.recv())
            .await
            .map_err(|_| {
                PluginError::new(PluginFailureKind::Timeout, "Node host activation timed out")
            })?
            .map_err(|_| {
                PluginError::new(PluginFailureKind::Process, "Node host event stream closed")
            })
    }

    pub(crate) async fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        self.cancellation.cancel();
        self.handles.lock().unwrap().clear();
        let _ = self
            .request(
                NodePluginDaemonMethod::Deactivate,
                &json!({}),
                self.limits.node_shutdown_timeout,
            )
            .await;
        let _ = self
            .request(
                NodePluginDaemonMethod::Shutdown,
                &json!({}),
                self.limits.node_shutdown_timeout,
            )
            .await;
        let mut child = self.child.lock().await;
        if tokio::time::timeout(self.limits.node_shutdown_timeout, child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }

    async fn force_kill(&self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.child.lock().await.kill().await;
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.failure.lock().unwrap().clone()
    }
}

pub(crate) struct NodeTool {
    public_name: String,
    guest_name: String,
    description: String,
    input_schema: Value,
    plugin: Arc<NodePluginProcess>,
    cancellation: CancellationToken,
}

impl NodeTool {
    pub(crate) fn new(
        plugin: Arc<NodePluginProcess>,
        metadata: NodeToolMetadata,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            public_name: format!("{}.{}", plugin.manifest.id, metadata.name),
            guest_name: metadata.name,
            description: metadata.description,
            input_schema: metadata.input_schema,
            plugin,
            cancellation,
        }
    }
}

#[async_trait]
impl Tool for NodeTool {
    fn name(&self) -> &str {
        &self.public_name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters_schema(&self) -> Value {
        self.input_schema.clone()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::High,
            reason: "trusted Node plugin executes with the current user account".into(),
        }
    }
    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        self.plugin
            .execute(&self.guest_name, input, self.cancellation.child_token())
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
    }
}

fn node_cli_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

async fn find_node(manifest: &PluginManifest) -> Result<PathBuf, PluginError> {
    let output = Command::new("node")
        .arg("-p")
        .arg("`${process.execPath}\\n${process.version}`")
        .output()
        .await
        .map_err(|error| {
            PluginError::new(
                PluginFailureKind::Incompatible,
                format!("Node.js 22 or newer is required: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(PluginError::new(
            PluginFailureKind::Incompatible,
            "Node.js version check failed",
        ));
    }
    let output = String::from_utf8_lossy(&output.stdout);
    let mut lines = output.lines();
    let executable = lines.next().unwrap_or_default().trim();
    let version = lines
        .next()
        .unwrap_or_default()
        .trim()
        .trim_start_matches('v')
        .to_string();
    if executable.is_empty() {
        return Err(PluginError::new(
            PluginFailureKind::Incompatible,
            "Node.js did not report its executable path",
        ));
    }
    let version = semver::Version::parse(&version).map_err(|_| {
        PluginError::new(
            PluginFailureKind::Incompatible,
            "Node.js returned an invalid version",
        )
    })?;
    let requirement = &manifest
        .engine
        .as_ref()
        .expect("validated Node engine")
        .node;
    if !requirement.matches(&version) {
        return Err(PluginError::new(
            PluginFailureKind::Incompatible,
            format!("Node {version} does not satisfy {requirement}"),
        ));
    }
    Ok(PathBuf::from(executable))
}

fn install_host(plugin_dir: &Path) -> Result<PathBuf, PluginError> {
    let directory = plugin_dir.join(".miniq-node-plugin-host-v1");
    std::fs::create_dir_all(&directory)
        .map_err(|error| PluginError::new(PluginFailureKind::Process, error.to_string()))?;
    let path = directory.join("host.mjs");
    std::fs::write(&path, HOST_SOURCE)
        .map_err(|error| PluginError::new(PluginFailureKind::Process, error.to_string()))?;
    path.canonicalize()
        .map_err(|error| PluginError::new(PluginFailureKind::Process, error.to_string()))
}

fn spawn_stdout_reader<R>(
    stdout: R,
    responses: Arc<Mutex<HashMap<u64, oneshot::Sender<NodePluginResponse>>>>,
    notifications: broadcast::Sender<NodePluginNotification>,
    handles: Arc<Mutex<Vec<RegistrationHandle>>>,
    cancellation: CancellationToken,
    stopping: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
    max_bytes: usize,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut stdout = stdout;
        let mut buffer = Vec::with_capacity(8192);
        let mut chunk = [0_u8; 8192];
        let mut exit_reason = "Node plugin host stdout closed".to_string();
        'read: loop {
            let count = match stdout.read(&mut chunk).await {
                Ok(0) => break,
                Err(error) => {
                    exit_reason = format!("Node plugin host stdout failed: {error}");
                    break;
                }
                Ok(count) => count,
            };
            buffer.extend_from_slice(&chunk[..count]);
            while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                if newline > max_bytes {
                    exit_reason = "Node plugin host sent an oversized protocol frame".to_string();
                    break 'read;
                }
                if let Err(error) =
                    process_stdout_frame(&buffer[..newline], &responses, &notifications)
                {
                    exit_reason =
                        format!("Node plugin host sent an invalid protocol frame: {error}");
                    break 'read;
                }
                buffer.drain(..=newline);
            }
            if buffer.len() > max_bytes {
                exit_reason = "Node plugin host sent an oversized protocol frame".to_string();
                break;
            }
        }
        if !stopping.load(Ordering::Acquire) {
            *failure.lock().unwrap() = Some(exit_reason);
        }
        cancellation.cancel();
        handles.lock().unwrap().clear();
        responses.lock().unwrap().clear();
    });
}

fn process_stdout_frame(
    frame: &[u8],
    responses: &Mutex<HashMap<u64, oneshot::Sender<NodePluginResponse>>>,
    notifications: &broadcast::Sender<NodePluginNotification>,
) -> Result<(), String> {
    let value: Value = serde_json::from_slice(frame).map_err(|error| error.to_string())?;
    if value.get("id").is_some() {
        let response: NodePluginResponse =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        let sender = responses
            .lock()
            .unwrap()
            .remove(&response.id)
            .ok_or_else(|| format!("unknown response id {}", response.id))?;
        let _ = sender.send(response);
    } else {
        let notification: NodePluginNotification =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        let _ = notifications.send(notification);
    }
    Ok(())
}

fn spawn_stderr_reader(stderr: tokio::process::ChildStderr, plugin_id: String, max_bytes: usize) {
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut chunk = [0_u8; 4096];
        let mut used = 0usize;
        loop {
            let count = match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            used = used.saturating_add(count);
            if used > max_bytes {
                tracing::warn!(%plugin_id, "Node plugin stderr limit exceeded");
                break;
            }
            tracing::warn!(
                %plugin_id,
                plugin_stderr = %String::from_utf8_lossy(&chunk[..count])
            );
        }
    });
}

fn decode_params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, PluginError> {
    serde_json::from_value(value).map_err(protocol_error)
}
fn protocol_error(error: impl std::fmt::Display) -> PluginError {
    PluginError::new(PluginFailureKind::Protocol, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_oversized_frame_before_newline() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let responses = Arc::new(Mutex::new(HashMap::new()));
        let (notifications, _) = broadcast::channel(4);
        let handles = Arc::new(Mutex::new(Vec::new()));
        let cancellation = CancellationToken::new();
        let stopping = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(None));
        spawn_stdout_reader(
            reader,
            responses,
            notifications,
            handles,
            cancellation.clone(),
            stopping,
            failure.clone(),
            16,
        );

        writer.write_all(&[b'x'; 17]).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), cancellation.cancelled())
            .await
            .unwrap();

        assert_eq!(
            failure.lock().unwrap().as_deref(),
            Some("Node plugin host sent an oversized protocol frame")
        );
    }
}
