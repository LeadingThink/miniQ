//! A PID is an address, not a process identity. Never signal an unverified PID.
use serde::{Deserialize, Serialize};
use std::{
    io,
    time::{Duration, Instant},
};

#[cfg(windows)]
#[path = "process/windows.rs"]
mod platform;
#[cfg(unix)]
#[path = "process/unix.rs"]
mod platform;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "platform",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProcessIdentity {
    Windows {
        created_at: u64,
    },
    Linux {
        boot_id: String,
        start_ticks: u64,
    },
    MacOs {
        boot_id: String,
        unique_id: u64,
        start_seconds: u64,
        start_microseconds: u64,
    },
}

pub struct DaemonProcess {
    inner: platform::Process,
    identity: ProcessIdentity,
}

impl DaemonProcess {
    /// Permission/query failures remain errors; only absence or a different identity is stale.
    pub fn open(pid: u32, expected: &ProcessIdentity) -> io::Result<Option<Self>> {
        let Some(inner) = platform::Process::open(pid)? else {
            return Ok(None);
        };
        if !inner.is_running()? {
            return Ok(None);
        }
        match inner.identity() {
            Ok(actual) if actual == *expected => {}
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
        Ok(Some(Self {
            inner,
            identity: expected.clone(),
        }))
    }

    pub fn current_identity() -> io::Result<ProcessIdentity> {
        platform::Process::open(std::process::id())?
            .ok_or_else(|| io::Error::other("current process disappeared"))?
            .identity()
    }

    pub fn is_running(&self) -> io::Result<bool> {
        if !self.inner.is_running()? {
            return Ok(false);
        }
        match self.inner.identity() {
            Ok(identity) => Ok(identity == self.identity),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub fn wait(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.is_running()? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "miniQ 后台未在限定时间内退出",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn stop(self, grace: Duration) -> io::Result<()> {
        match self.wait(grace) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
            Err(error) => return Err(error),
        }
        if self.is_running()? {
            self.inner.terminate(&self.identity)?;
        }
        self.wait(Duration::from_secs(5))
    }
}

pub(super) fn validate_pid(pid: u32) -> io::Result<()> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid daemon PID",
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
