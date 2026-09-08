//! Daemon discovery and launch.
//!
//! The daemon writes `daemon.json` (port/token/pid) into the miniQ data dir
//! on startup. The shell reads it, health-checks the port, and spawns the
//! daemon binary if nothing is running.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::daemon_process::DaemonProcess;
pub use miniq_local::ConnectionInfo;
use miniq_local::{data_dir, health_ok};

fn read_connection_info() -> Option<ConnectionInfo> {
    miniq_local::read_connection_info(&data_dir())
}

#[derive(Default)]
pub struct DaemonLifecycle {
    update: Mutex<Option<DaemonProcess>>,
}

impl DaemonLifecycle {
    pub fn ensure(&self) -> Result<ConnectionInfo, String> {
        // Serialize startup with update preparation so an in-flight reconnect cannot respawn it.
        let update = self.update.lock().map_err(|e| e.to_string())?;
        if update.is_some() {
            return Err("daemon startup is paused while installing an update".into());
        }
        ensure_daemon()
    }

    pub fn prepare_update(&self) -> Result<(), String> {
        let mut update = self.update.lock().map_err(|e| e.to_string())?;
        if update.is_some() {
            return Err("a daemon update is already in progress".into());
        }
        let info = read_connection_info().ok_or("daemon connection information is unavailable")?;
        *update = Some(DaemonProcess::open(info.pid)?);
        Ok(())
    }

    pub fn wait_for_exit(&self) -> Result<(), String> {
        let update = self.update.lock().map_err(|e| e.to_string())?;
        update
            .as_ref()
            .ok_or("daemon update has not been prepared")?
            .wait(Duration::from_secs(30))
    }

    pub fn cancel_update(&self) -> Result<(), String> {
        self.update.lock().map_err(|e| e.to_string())?.take();
        Ok(())
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

fn spawn_daemon() -> Result<(), String> {
    let binary = daemon_binary_candidates()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            "miniq-daemon binary not found; build it with `cargo build -p miniq-daemon` \
             or set MINIQ_DAEMON_PATH"
                .to_string()
        })?;
    let mut cmd = std::process::Command::new(&binary);
    // Release builds hide the daemon's console window; debug builds keep it
    // attached so `tauri dev` still shows daemon logs in the terminal.
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to start {}: {e}", binary.display()))?;
    Ok(())
}

/// Return connection info for a healthy daemon, starting one if needed.
fn ensure_daemon() -> Result<ConnectionInfo, String> {
    if let Some(info) = read_connection_info() {
        if health_ok(info.port) {
            return Ok(info);
        }
    }
    spawn_daemon()?;
    // Wait for the fresh daemon.json + a passing health check.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(info) = read_connection_info() {
            if health_ok(info.port) {
                return Ok(info);
            }
        }
    }
    Err("daemon did not become healthy within 10s".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_guard_blocks_startup_until_cancelled() {
        let lifecycle = DaemonLifecycle {
            update: Mutex::new(Some(DaemonProcess::open(std::process::id()).unwrap())),
        };
        assert!(lifecycle.ensure().unwrap_err().contains("paused"));
        assert!(lifecycle
            .prepare_update()
            .unwrap_err()
            .contains("already in progress"));
        lifecycle.cancel_update().unwrap();
        assert!(lifecycle.update.lock().unwrap().is_none());
        assert!(lifecycle
            .wait_for_exit()
            .unwrap_err()
            .contains("not been prepared"));
    }
}
