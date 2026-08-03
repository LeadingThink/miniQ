//! Daemon discovery and launch.
//!
//! The daemon writes `daemon.json` (port/token/pid) into the miniQ data dir
//! on startup. The shell reads it, health-checks the port, and spawns the
//! daemon binary if nothing is running.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
}

fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MINIQ_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.local/share")))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("miniq")
}

fn read_connection_info() -> Option<ConnectionInfo> {
    let raw = std::fs::read_to_string(data_dir().join("daemon.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn wait_for_exit() -> Result<(), String> {
    let Some(info) = read_connection_info() else {
        return Ok(());
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !health_ok(info.port) {
            std::thread::sleep(Duration::from_millis(300));
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "miniq-daemon process {} did not exit within 10 seconds",
        info.pid
    ))
}

/// Minimal HTTP GET /health probe over a raw TCP socket (avoids pulling an
/// HTTP client into the shell).
fn health_ok(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().expect("valid loopback addr"),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let request = format!("GET /health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
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
pub fn ensure_daemon() -> Result<ConnectionInfo, String> {
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
