//! Desktop policy around the shared daemon lifecycle.
pub use miniq_local::ConnectionInfo;
use miniq_local::{
    data_dir,
    lifecycle::{self, OperationLock},
    DaemonProcess,
};
use std::{io, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{Mutex, OnceCell};
use tokio_util::sync::CancellationToken;

struct UpdateGuard {
    operation: OperationLock,
    process: Arc<DaemonProcess>,
}

#[derive(Default)]
pub struct DaemonLifecycle {
    update: Mutex<Option<UpdateGuard>>,
    shutdown: CancellationToken,
    runtime_path: OnceCell<miniq_local::runtime_path::PathResolution>,
}

impl DaemonLifecycle {
    pub async fn migrate_to(&self, target: PathBuf) -> Result<(), String> {
        let update = self.update.lock().await;
        if self.shutdown.is_cancelled() {
            return Err("miniQ is exiting".into());
        }
        if update.is_some() {
            return Err("data migration is paused while installing an update".into());
        }
        let source = data_dir();
        let target = std::fs::canonicalize(target).map_err(|e| e.to_string())?;
        let source = std::fs::canonicalize(source).map_err(|e| e.to_string())?;
        if source == target {
            return Ok(());
        }
        if target.starts_with(&source) || source.starts_with(&target) {
            return Err("新旧数据目录不能相互包含".into());
        }
        let operation = OperationLock::acquire(&source, lifecycle::START_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        let destination = OperationLock::acquire(&target, lifecycle::START_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        if std::fs::read_dir(&target)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err("目标数据目录必须为空".into());
        }
        let source_guard = operation
            .stop_and_retain(Duration::from_secs(10))
            .await
            .map_err(|e| e.to_string())?;
        // Keep both locks with the blocking move even if the invoking webview disappears.
        let (source_guard, destination) = tokio::task::spawn_blocking(move || {
            miniq_local::migrate_data_dir(&source, &target).map_err(|e| e.to_string())?;
            if let Err(config_error) = miniq_local::write_data_dir_config(&target) {
                return match miniq_local::migrate_data_dir(&target, &source) {
                    Ok(()) => Err(format!("无法保存数据目录设置，数据已移回原目录: {config_error}")),
                    Err(rollback_error) => Err(format!("无法保存数据目录设置，且数据无法移回原目录: {config_error}; {rollback_error}")),
                };
            }
            Ok((source_guard, destination))
        }).await.map_err(|e| e.to_string())??;
        let path = self
            .runtime_path
            .get_or_try_init(|| async {
                tokio::task::spawn_blocking(resolve_runtime_path)
                    .await
                    .map_err(|e| e.to_string())
            })
            .await?;
        let result = destination
            .ensure(
                || daemon_command(path),
                lifecycle::START_TIMEOUT,
                &self.shutdown,
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string());
        drop(source_guard);
        result
    }

    pub async fn ensure(&self) -> Result<ConnectionInfo, String> {
        let update = self.update.lock().await;
        if self.shutdown.is_cancelled() {
            return Err("daemon startup is blocked while miniQ is exiting".into());
        }
        if update.is_some() {
            return Err("daemon startup is paused while installing an update".into());
        }
        let path = self
            .runtime_path
            .get_or_try_init(|| async {
                tokio::task::spawn_blocking(resolve_runtime_path)
                    .await
                    .map_err(|error| error.to_string())
            })
            .await?;
        lifecycle::ensure(
            &data_dir(),
            || daemon_command(path),
            lifecycle::START_TIMEOUT,
            &self.shutdown,
        )
        .await
        .map_err(|error| error.to_string())
    }

    pub async fn prepare_update(&self) -> Result<(), String> {
        let mut update = self.update.lock().await;
        if self.shutdown.is_cancelled() {
            return Err("miniQ is exiting".into());
        }
        if update.is_some() {
            return Err("a daemon update is already in progress".into());
        }
        let directory = data_dir();
        let operation = tokio::select! {
            _ = self.shutdown.cancelled() => return Err("miniQ is exiting".into()),
            result = OperationLock::acquire(&directory, lifecycle::START_TIMEOUT) => result.map_err(|e| e.to_string())?,
        };
        let info = miniq_local::read_connection_info(&directory)
            .map_err(|e| e.to_string())?
            .ok_or("daemon connection information is unavailable")?;
        let process = DaemonProcess::open(info.pid, &info.process_identity)
            .map_err(|e| e.to_string())?
            .ok_or("daemon process has exited or its identity changed")?;
        *update = Some(UpdateGuard {
            operation,
            process: Arc::new(process),
        });
        Ok(())
    }

    pub async fn wait_for_exit(&self) -> Result<(), String> {
        let update = self.update.lock().await;
        let process = update
            .as_ref()
            .ok_or("daemon update has not been prepared")?
            .process
            .clone();
        tokio::task::spawn_blocking(move || process.wait(Duration::from_secs(30)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }

    pub async fn cancel_update(&self) -> Result<(), String> {
        self.update.lock().await.take();
        Ok(())
    }

    pub fn begin_shutdown(&self) {
        self.shutdown.cancel();
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.begin_shutdown();
        // Startup cancellation finishes killing/reaping our own child before this guard releases.
        let mut update = self.update.lock().await;
        let result = if let Some(update) = update.take() {
            update.operation.stop(Duration::from_secs(10)).await
        } else {
            lifecycle::stop(&data_dir(), Duration::from_secs(10)).await
        };
        result.map_err(|e| e.to_string())
    }
}

/// Candidate locations for the daemon binary.
fn daemon_binary_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(explicit) = std::env::var("MINIQ_DAEMON_PATH") {
        candidates.push(PathBuf::from(explicit));
    }
    let exe_name = if cfg!(windows) {
        "miniq-daemon.exe"
    } else {
        "miniq-daemon"
    };
    // Dev builds prefer the workspace target dir: it holds the freshly built
    // daemon, while the copy next to the shell exe is a possibly stale
    // sidecar snapshot from `binaries/`. src-tauri is three levels below the
    // repo root (apps/desktop/src-tauri).
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(repo_root) = manifest_dir.ancestors().nth(3) {
            if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
                candidates.push(PathBuf::from(target_dir).join("debug").join(exe_name));
            }
            candidates.push(repo_root.join("target").join("debug").join(exe_name));
            candidates.push(repo_root.join("target").join("release").join(exe_name));
        }
    }
    // Next to the shell executable (bundled installs).
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            candidates.push(dir.join(exe_name));
        }
    }
    candidates
}

fn resolve_runtime_path() -> miniq_local::runtime_path::PathResolution {
    let result = miniq_local::runtime_path::resolve();
    let status = match &result.diagnostic {
        Some(error) => format!("PATH initialization fell back to the process environment: {error}"),
        None => "PATH initialization completed".to_owned(),
    };
    eprintln!("[miniq] {status}");
    let directory = data_dir().join("logs");
    if let Err(error) = std::fs::create_dir_all(&directory)
        .and_then(|()| std::fs::write(directory.join("desktop-path.log"), status))
    {
        eprintln!("[miniq] could not save PATH diagnostic: {error}");
    }
    result
}

fn daemon_command(
    path: &miniq_local::runtime_path::PathResolution,
) -> io::Result<std::process::Command> {
    let binary = daemon_binary_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "miniq-daemon binary not found; build the daemon or set MINIQ_DAEMON_PATH",
            )
        })?;
    let mut command = std::process::Command::new(binary.canonicalize()?);
    if let Some(path) = &path.path {
        command.env("PATH", path);
    }
    Ok(command)
}

#[cfg(test)]
mod tests;
