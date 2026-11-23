//! Keep the computer reachable from the phone while remote access is on.
//!
//! A phone in the user's pocket drops its WebSocket, so "connected mobile
//! clients" cannot drive this. Instead, whenever the daemon is configured to
//! hold a relay connection, it holds an idle-sleep assertion. The display may
//! still turn off, and closing the lid or choosing Sleep still sleeps the
//! machine. The lease lives in the daemon (not the desktop window) because the
//! daemon keeps serving the phone after the window quits.

use std::process::{Child, ExitStatus};
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::state::{AppState, DaemonSettings};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// How long to wait before retrying a helper that exited with failure
/// (e.g. polkit denying `systemd-inhibit` on headless Linux). Retrying every
/// poll would turn one permanent denial into a hot respawn loop, each cycle
/// producing another denied polkit check.
const FAILURE_RETRY_DELAY: Duration = Duration::from_secs(600);

/// True while the daemon tries to keep a relay connection open.
pub(crate) fn wants_keep_awake(settings: &DaemonSettings) -> bool {
    settings.remote_access.enabled
        && settings
            .provider
            .as_ref()
            .is_some_and(|provider| !provider.api_key.trim().is_empty())
}

pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut lease = Lease::default();
        loop {
            let wanted = wants_keep_awake(&state.settings.lock().unwrap());
            lease.set(wanted);
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = state.shutdown.cancelled() => break,
            }
        }
        lease.set(false);
    });
}

#[derive(Default)]
pub(crate) struct Lease {
    child: Option<Child>,
    /// Avoid spamming the log every poll when the platform has no helper.
    reported_failure: bool,
    /// While set, a failed helper must not be restarted until the deadline.
    /// A non-zero exit means the platform refused the request (e.g. polkit
    /// "Access denied"), which retries will not fix.
    retry_after: Option<Instant>,
}

impl Lease {
    pub(crate) fn set(&mut self, enabled: bool) {
        if !enabled {
            self.release();
            self.reported_failure = false;
            self.retry_after = None;
            return;
        }
        if let Some(deadline) = self.retry_after {
            if Instant::now() < deadline {
                // Last helper failed permanently; stay quiet instead of
                // respawning every poll. Reap the zombie if still around.
                if let Some(child) = self.child.as_mut() {
                    let _ = child.try_wait();
                }
                return;
            }
            self.retry_after = None;
        }
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return,
                Ok(Some(status)) => {
                    match status.code() {
                        // Exited cleanly, or killed by a signal from outside
                        // (e.g. an admin reaping a stale helper): start a
                        // replacement.
                        Some(0) | None => self.child = None,
                        // Non-zero exit: the helper itself reported failure
                        // (e.g. polkit denied `systemd-inhibit` on headless
                        // Linux). That refusal is permanent, so back off
                        // instead of respawning on every poll.
                        Some(_) => {
                            self.note_failed_exit(status);
                            return;
                        }
                    }
                }
                // Lost track of the helper; fall through and start a new one.
                Err(_) => self.child = None,
            }
        }
        match start_helper() {
            Ok(child) => {
                tracing::info!("remote access on: preventing idle system sleep");
                self.child = Some(child);
                self.reported_failure = false;
            }
            Err(error) if !self.reported_failure => {
                tracing::warn!(%error, "could not prevent idle system sleep for remote access");
                self.reported_failure = true;
            }
            Err(_) => {}
        }
    }

    /// Records a helper that exited with failure (e.g. polkit denying
    /// `systemd-inhibit` on headless Linux). The refusal is permanent, so the
    /// next attempt backs off instead of respawning on every poll.
    fn note_failed_exit(&mut self, status: ExitStatus) {
        self.child = None;
        self.retry_after = Some(Instant::now() + FAILURE_RETRY_DELAY);
        if !self.reported_failure {
            tracing::warn!(?status, "keep-awake helper failed, backing off");
            self.reported_failure = true;
        }
    }

    #[cfg(test)]
    pub(crate) fn helper_pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    fn release(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
            tracing::info!("remote access off: idle system sleep allowed again");
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(target_os = "macos")]
fn start_helper() -> std::io::Result<Child> {
    // -i: idle system sleep only (display may sleep; lid close still sleeps).
    // -w: the assertion also ends if the daemon dies without cleanup.
    Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

#[cfg(target_os = "linux")]
fn start_helper() -> std::io::Result<Child> {
    Command::new("systemd-inhibit")
        .args([
            "--what=idle:sleep",
            "--who=miniQ",
            "--why=Remote access from phone",
            "--mode=block",
            "sleep",
            "infinity",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn start_helper() -> std::io::Result<Child> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "idle sleep prevention is not implemented on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(enabled: bool, key: &str) -> DaemonSettings {
        let mut settings = DaemonSettings::default();
        settings.remote_access.enabled = enabled;
        if !key.is_empty() {
            settings.provider = Some(
                serde_json::from_value(serde_json::json!({
                    "baseUrl": "https://example.invalid/v1",
                    "apiKey": key,
                    "model": "test",
                }))
                .unwrap(),
            );
        }
        settings
    }

    #[test]
    fn only_holds_while_a_relay_connection_is_wanted() {
        assert!(wants_keep_awake(&settings(true, "sk-test")));
        assert!(!wants_keep_awake(&settings(false, "sk-test")));
        assert!(!wants_keep_awake(&settings(true, "")));
        assert!(!wants_keep_awake(&settings(true, "   ")));
    }

    #[cfg(unix)]
    #[test]
    fn failed_helper_backs_off_instead_of_respawning() {
        use std::os::unix::process::ExitStatusExt;

        let mut lease = Lease::default();
        // Simulate `systemd-inhibit` refused by polkit (exit code 1).
        lease.note_failed_exit(ExitStatus::from_raw(1 << 8));
        assert!(lease.retry_after.is_some());
        // While backing off, polling must not start a replacement helper:
        // previously this respawned every poll, each cycle producing another
        // denied polkit check.
        lease.set(true);
        assert_eq!(lease.helper_pid(), None);

        // A fresh lease has no backoff armed.
        assert!(Lease::default().retry_after.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lease_is_idempotent_restarts_and_is_reaped() {
        let alive = |pid: u32| {
            Command::new("/bin/ps")
                .args(["-p", &pid.to_string()])
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        let mut lease = Lease::default();
        lease.set(true);
        let pid = lease.helper_pid().unwrap();
        lease.set(true);
        assert_eq!(lease.helper_pid(), Some(pid));

        // A helper killed from outside is replaced on the next poll.
        lease.child.as_mut().unwrap().kill().unwrap();
        lease.child.as_mut().unwrap().wait().unwrap();
        lease.set(true);
        let replacement = lease.helper_pid().unwrap();
        assert_ne!(replacement, pid);

        lease.set(false);
        assert_eq!(lease.helper_pid(), None);
        assert!(!alive(replacement));

        lease.set(true);
        let dropped = lease.helper_pid().unwrap();
        drop(lease);
        assert!(!alive(dropped));
    }
}
