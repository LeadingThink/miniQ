//! Local daemon discovery shared by the desktop, terminal and daemon.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fs2::FileExt;
use serde::{Deserialize, Serialize};

// Debug is implemented below with the connection token redacted.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
}

impl std::fmt::Debug for ConnectionInfo {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectionInfo")
            .field("port", &self.port)
            .field("pid", &self.pid)
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

pub fn read_connection_info(dir: &Path) -> Option<ConnectionInfo> {
    serde_json::from_slice(&std::fs::read(dir.join("daemon.json")).ok()?).ok()
}

pub fn write_connection_info(dir: &Path, info: &ConnectionInfo) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    write_private_json(&dir.join("daemon.json"), info)
}

pub fn write_private_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
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
        file.try_lock_exclusive()?;
        Ok(Self { _file: file })
    }
}

/// This probe is only for discovery; clients must authenticate before issuing RPCs.
pub fn health_ok(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    if write!(
        stream,
        "GET /health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut response = [0u8; 12];
    stream.read_exact(&mut response).is_ok()
        && (&response == b"HTTP/1.1 200" || &response == b"HTTP/1.0 200")
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
                &ConnectionInfo {
                    port,
                    token: "fixture".into(),
                    pid: 1,
                },
            )
            .unwrap();
            assert_eq!(read_connection_info(dir.path()).unwrap().port, port);
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
