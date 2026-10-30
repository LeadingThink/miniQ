//! Local daemon discovery shared by the desktop, terminal and daemon.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
pub mod lifecycle;
pub mod process;
pub use process::{DaemonProcess, ProcessIdentity};

// Debug is implemented below with the connection token redacted.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub process_identity: ProcessIdentity,
}

impl ConnectionInfo {
    pub fn current(port: u16, token: String) -> io::Result<Self> {
        Ok(Self {
            port,
            token,
            pid: std::process::id(),
            process_identity: DaemonProcess::current_identity()?,
        })
    }
}

impl std::fmt::Debug for ConnectionInfo {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectionInfo")
            .field("port", &self.port)
            .field("pid", &self.pid)
            .field("process_identity", &self.process_identity)
            .field("token", &"[redacted]")
            .finish()
    }
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MINIQ_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("miniq")
}

pub fn read_connection_info(dir: &Path) -> io::Result<Option<ConnectionInfo>> {
    let bytes = match std::fs::read(dir.join("daemon.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "无法验证后台连接记录 {}：{error}",
                dir.join("daemon.json").display()
            ),
        )
    })
}

pub fn write_connection_info(dir: &Path, info: &ConnectionInfo) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    write_private_json(&dir.join("daemon.json"), info)
}

pub fn write_private_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    write_private_bytes(path, &serde_json::to_vec_pretty(value)?)
}

/// Atomically write bytes to an owner-only (0600 on Unix) file.
pub fn write_private_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// OS lock lives for the lifetime of the daemon, including crash cleanup.
pub struct DaemonLock {
    _file: File,
}

impl DaemonLock {
    pub fn acquire(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("daemon.lock"))?;
        try_exclusive_lock(&file)?;
        Ok(Self { _file: file })
    }
}

pub(crate) fn try_exclusive_lock(file: &File) -> io::Result<()> {
    file.try_lock_exclusive().map_err(|error| {
        // fs2 reports ERROR_LOCK_VIOLATION on Windows, which std does not classify as WouldBlock.
        if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
            io::Error::new(io::ErrorKind::WouldBlock, error)
        } else {
            error
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lock_excludes_a_second_daemon_and_releases_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let lock = DaemonLock::acquire(dir.path()).unwrap();
        assert!(DaemonLock::acquire(dir.path()).is_err());
        drop(lock);
        assert!(DaemonLock::acquire(dir.path()).is_ok());
    }
    #[test]
    fn connection_file_is_replaced_atomically_and_is_private() {
        let dir = tempfile::tempdir().unwrap();
        for port in [1000, 2000] {
            write_connection_info(
                dir.path(),
                &ConnectionInfo::current(port, "fixture".into()).unwrap(),
            )
            .unwrap();
            assert_eq!(
                read_connection_info(dir.path()).unwrap().unwrap().port,
                port
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("daemon.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
pub mod files;
pub mod runtime_path;
pub mod subprocess_env;
