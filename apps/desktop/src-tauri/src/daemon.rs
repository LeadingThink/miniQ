//! Daemon discovery and launch.
//!
//! The daemon writes `daemon.json` (port/token/pid) into the miniQ data dir
//! on startup. The shell reads it, health-checks the port, and spawns the
//! daemon binary if nothing is running.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use super::daemon_process::DaemonProcess;
pub use miniq_local::ConnectionInfo;
use miniq_local::{data_dir, health_ok};

const DAEMON_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const DAEMON_HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(250);

fn read_connection_info() -> Option<ConnectionInfo> {
    miniq_local::read_connection_info(&data_dir())
}

#[derive(Default)]
pub struct DaemonLifecycle {
    update: Mutex<Option<DaemonProcess>>,
    exiting: AtomicBool,
}

impl DaemonLifecycle {
    pub fn ensure(&self) -> Result<ConnectionInfo, String> {
        if self.exiting.load(Ordering::SeqCst) {
            return Err("daemon startup is blocked while miniQ is exiting".into());
        }
        // Serialize startup with update preparation so an in-flight reconnect cannot respawn it.
        let update = self.update.lock().map_err(|e| e.to_string())?;
        if self.exiting.load(Ordering::SeqCst) {
            return Err("daemon startup is blocked while miniQ is exiting".into());
        }
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

    pub fn begin_shutdown(&self) {
        self.exiting.store(true, Ordering::SeqCst);
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.begin_shutdown();
        // Wait for an ensure() that already passed the exit check. Once its
        // startup lock is released, daemon.json points at the process to stop.
        {
            let _startup = self.update.lock().map_err(|error| error.to_string())?;
        }
        let Some(info) = read_connection_info() else {
            return Ok(());
        };
        let process = DaemonProcess::open(info.pid)?;
        request_shutdown(&info).await?;
        tauri::async_runtime::spawn_blocking(move || process.stop(Duration::from_secs(10)))
            .await
            .map_err(|error| error.to_string())?
    }
}

async fn request_shutdown(info: &ConnectionInfo) -> Result<(), String> {
    let mut url = url::Url::parse(&format!("ws://127.0.0.1:{}/ws", info.port))
        .map_err(|_| "invalid daemon shutdown URL".to_owned())?;
    url.query_pairs_mut().append_pair("token", &info.token);
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(3),
        tokio_tungstenite::connect_async(url.as_str()),
    )
    .await
    .map_err(|_| "daemon shutdown connection timed out".to_owned())?
    .map_err(|_| "daemon shutdown connection failed".to_owned())?;
    socket
        .send(Message::text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "desktop-quit",
                "method": "daemon.shutdown"
            })
            .to_string(),
        ))
        .await
        .map_err(|_| "daemon shutdown request failed".to_owned())?;

    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|_| "daemon shutdown response failed".to_owned())?;
            let Message::Text(text) = message else {
                continue;
            };
            let response: Value = serde_json::from_str(&text)
                .map_err(|_| "daemon returned an invalid shutdown response".to_owned())?;
            if response["id"] != "desktop-quit" {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(format!(
                    "daemon rejected shutdown: {}",
                    error["message"].as_str().unwrap_or("unknown error")
                ));
            }
            return Ok(());
        }
        Err("daemon disconnected before confirming shutdown".to_owned())
    })
    .await
    .map_err(|_| "daemon shutdown response timed out".to_owned())?
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

        // A daemon can have written its connection file before its HTTP
        // health endpoint is ready. Reusing that process avoids launching a
        // second daemon, which would lose the startup race on daemon.lock and
        // leave the shell waiting on stale connection information.
        if daemon_process_alive(info.pid) {
            return wait_for_healthy(DAEMON_STARTUP_TIMEOUT);
        }
    }
    spawn_daemon()?;
    wait_for_healthy(DAEMON_STARTUP_TIMEOUT)
}

fn wait_for_healthy(timeout: Duration) -> Result<ConnectionInfo, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        std::thread::sleep(DAEMON_HEALTH_POLL_INTERVAL);
        if let Some(info) = read_connection_info() {
            if health_ok(info.port) {
                return Ok(info);
            }
        }
    }
    Err(format!(
        "本地后台服务在 {} 秒内未就绪；这与远程中继无关，请重试或查看 miniQ 日志",
        timeout.as_secs()
    ))
}

fn daemon_process_alive(pid: u32) -> bool {
    DaemonProcess::open(pid)
        .and_then(|process| process.is_running())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::tungstenite::Message;

    #[test]
    fn update_guard_blocks_startup_until_cancelled() {
        let lifecycle = DaemonLifecycle {
            update: Mutex::new(Some(DaemonProcess::open(std::process::id()).unwrap())),
            exiting: AtomicBool::new(false),
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
        lifecycle.begin_shutdown();
        assert!(lifecycle.ensure().unwrap_err().contains("exiting"));
    }

    #[tokio::test]
    async fn shutdown_request_is_authenticated_and_waits_for_confirmation() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &Request, response: Response| {
                    assert_eq!(request.uri().query(), Some("token=test-token"));
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let Message::Text(request) = socket.next().await.unwrap().unwrap() else {
                panic!("expected a text shutdown request");
            };
            let request: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(request["method"], "daemon.shutdown");
            socket
                .send(Message::text(
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": "desktop-quit",
                        "result": {"accepted": true}
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
        });

        request_shutdown(&ConnectionInfo {
            port,
            token: "test-token".to_owned(),
            pid: std::process::id(),
        })
        .await
        .unwrap();
        server.await.unwrap();
    }

    #[test]
    fn process_liveness_rejects_missing_pid_and_accepts_current_process() {
        assert!(!daemon_process_alive(0));
        assert!(daemon_process_alive(std::process::id()));
    }
}
