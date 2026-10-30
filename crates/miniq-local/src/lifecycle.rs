//! Shared desktop/CLI startup and stop, serialized across processes.
use crate::{read_connection_info, ConnectionInfo, DaemonLock, DaemonProcess};
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio::time::{sleep, Instant};
use tokio_util::sync::CancellationToken;

mod launch;
mod rpc;
pub use rpc::probe;
const POLL: Duration = Duration::from_millis(50);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
pub const START_TIMEOUT: Duration = Duration::from_secs(90);

/// Hold this through an update's stop/install/wait sequence as well as ordinary startup/stop.
pub struct OperationLock {
    _file: File,
    directory: PathBuf,
}

impl OperationLock {
    pub async fn acquire(directory: &Path, timeout: Duration) -> io::Result<Self> {
        let file = launch::operation_file(directory)?;
        let deadline = Instant::now() + timeout;
        loop {
            match crate::try_exclusive_lock(&file) {
                Ok(()) => {
                    return Ok(Self {
                        _file: file,
                        directory: std::fs::canonicalize(directory)?,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "另一客户端正在启动、停止或更新后台，请稍后重试",
                ));
            }
            sleep(POLL).await;
        }
    }

    /// Start while retaining an update transaction's lock through activation.
    pub async fn ensure(
        &self,
        command: impl FnOnce() -> io::Result<Command>,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> io::Result<ConnectionInfo> {
        ensure_locked(&self.directory, command, timeout, cancel).await
    }

    pub async fn stop(self, grace: Duration) -> io::Result<()> {
        // Keep ownership of the operation lock even if the caller drops its future.
        tokio::spawn(async move {
            let _operation = self;
            let Some(info) = read_connection_info(&_operation.directory)? else {
                return Ok(());
            };
            let Some(process) = DaemonProcess::open(info.pid, &info.process_identity)? else {
                return Ok(());
            };
            stop_verified(info, process, grace).await
        })
        .await
        .map_err(io::Error::other)?
    }
}

pub async fn ensure(
    directory: &Path,
    command: impl FnOnce() -> io::Result<Command>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> io::Result<ConnectionInfo> {
    let deadline = Instant::now() + timeout;
    let operation = tokio::select! {
        _ = cancel.cancelled() => return Err(cancelled()),
        result = OperationLock::acquire(directory, timeout) => result?,
    };
    operation
        .ensure(
            command,
            deadline.saturating_duration_since(Instant::now()),
            cancel,
        )
        .await
}

async fn ensure_locked(
    directory: &Path,
    command: impl FnOnce() -> io::Result<Command>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> io::Result<ConnectionInfo> {
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    if timeout.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "等待后台生命周期操作超时",
        ));
    }
    let deadline = Instant::now() + timeout;
    let mut launch = None;
    let mut existing = None;
    let record = read_connection_info(directory);
    if let Ok(Some(info)) = &record {
        existing = DaemonProcess::open(info.pid, &info.process_identity)?;
    }
    if existing.is_none() {
        match DaemonLock::acquire(directory) {
            Ok(available) => {
                // A malformed/old record is replaceable only when no daemon owns this directory.
                if let Err(error) = record {
                    if error.kind() != io::ErrorKind::InvalidData {
                        return Err(error);
                    }
                    std::fs::remove_file(directory.join("daemon.json"))?;
                }
                drop(available);
                launch = Some(launch::Launch::start(directory, command()?)?);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                // A direct daemon launch may hold the instance lock before publishing its record.
                record?;
            }
            Err(error) => return Err(error),
        }
    }
    let result = tokio::select! {
        _ = cancel.cancelled() => Err(cancelled()),
        result = wait_ready(directory, deadline, &mut launch, existing) => result,
    };
    if cancel.is_cancelled() {
        if let Some(launch) = &mut launch {
            launch.cancel().await?;
        }
        return Err(cancelled());
    }
    result
}

async fn wait_ready(
    directory: &Path,
    deadline: Instant,
    launch: &mut Option<launch::Launch>,
    mut existing: Option<DaemonProcess>,
) -> io::Result<ConnectionInfo> {
    loop {
        if let Some(launch) = launch.as_mut() {
            launch.check_exit()?;
        }
        if let Some(process) = &existing {
            if !process.is_running()? {
                return Err(io::Error::other("miniQ 后台在就绪前退出，请查看后台日志"));
            }
        }
        if let Some(info) = read_connection_info(directory)? {
            let launched_pid = launch
                .as_ref()
                .and_then(|launch| launch.child.as_ref()?.id());
            if launched_pid.is_none_or(|pid| pid == info.pid) {
                if let Some(process) = DaemonProcess::open(info.pid, &info.process_identity)? {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match probe(&info, PROBE_TIMEOUT.min(remaining)).await {
                        Ok(()) if process.is_running()? => return Ok(info),
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidData
                            ) =>
                        {
                            return Err(error)
                        }
                        _ => {}
                    }
                    existing = Some(process);
                }
            }
        }
        if Instant::now() >= deadline {
            let logs = launch
                .as_ref()
                .map(|launch| launch.log.clone())
                .unwrap_or_else(|| directory.join("logs"));
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "miniQ 后台仍未就绪，已保留运行中的进程；请查看日志：{}",
                    logs.display()
                ),
            ));
        }
        sleep(POLL).await;
    }
}

/// Explicit app exit authorizes bounded cleanup, but only after identity verification.
pub async fn stop(directory: &Path, grace: Duration) -> io::Result<()> {
    let operation = OperationLock::acquire(directory, START_TIMEOUT).await?;
    operation.stop(grace).await
}

async fn stop_verified(
    info: ConnectionInfo,
    process: DaemonProcess,
    grace: Duration,
) -> io::Result<()> {
    let shutdown = rpc::call(&info, "daemon.shutdown", PROBE_TIMEOUT).await;
    if shutdown.is_err() {
        tracing::warn!(
            pid = info.pid,
            "daemon shutdown RPC failed; waiting before identity-checked cleanup"
        );
    }
    tokio::task::spawn_blocking(move || process.stop(grace))
        .await
        .map_err(io::Error::other)?
}

fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "miniQ 已取消后台启动")
}

#[cfg(test)]
mod tests;
