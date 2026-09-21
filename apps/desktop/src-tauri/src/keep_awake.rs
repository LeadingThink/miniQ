use std::process::Child;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct KeepAwakeState(Mutex<Option<Child>>);

impl KeepAwakeState {
    pub(crate) fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut lease = self.0.lock().map_err(|_| "防休眠状态不可用".to_string())?;
        if !enabled {
            if let Some(mut child) = lease.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Ok(());
        }
        if let Some(child) = lease.as_mut() {
            match child.try_wait().map_err(|error| error.to_string())? {
                None => return Ok(()),
                Some(_) => {
                    lease.take();
                }
            }
        }
        *lease = Some(start_lease()?);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn start_lease() -> Result<Child, String> {
    // Only prevent idle system sleep. Do not force the display on or claim to
    // override closing the lid. -w also releases the assertion after a crash.
    Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启用防休眠：{error}"))
}

#[cfg(not(target_os = "macos"))]
fn start_lease() -> Result<Child, String> {
    Err("当前平台尚不支持自动防休眠".into())
}

impl Drop for KeepAwakeState {
    fn drop(&mut self) {
        let _ = self.set_enabled(false);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn native_lease_is_idempotent_and_reaped_after_release() {
        let state = KeepAwakeState::default();
        state.set_enabled(true).unwrap();
        let pid = state.0.lock().unwrap().as_ref().unwrap().id();
        state.set_enabled(true).unwrap();
        assert_eq!(state.0.lock().unwrap().as_ref().unwrap().id(), pid);
        state.set_enabled(false).unwrap();
        assert!(state.0.lock().unwrap().is_none());
        assert!(!Command::new("/bin/ps")
            .args(["-p", &pid.to_string()])
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success());
        state.set_enabled(false).unwrap();
    }
}
