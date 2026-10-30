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
    let default = default_data_dir();
    read_configured_data_dir(&data_dir_config_path(&default)).unwrap_or(default)
}

pub fn data_dir_is_managed_by_environment() -> bool {
    std::env::var_os("MINIQ_DATA_DIR").is_some()
}

fn default_data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("miniq")
}

fn data_dir_config_path(default: &Path) -> PathBuf {
    default
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("miniq-data-dir.json")
}

#[derive(Deserialize, Serialize)]
struct DataDirConfig {
    data_dir: PathBuf,
}

fn read_configured_data_dir(path: &Path) -> Option<PathBuf> {
    serde_json::from_slice::<DataDirConfig>(&std::fs::read(path).ok()?)
        .ok()
        .map(|config| config.data_dir)
}

pub fn configured_data_dir() -> PathBuf {
    data_dir()
}

pub fn write_data_dir_config(path: &Path) -> std::io::Result<()> {
    let default = default_data_dir();
    write_private_json(
        &data_dir_config_path(&default),
        &DataDirConfig {
            data_dir: path.to_path_buf(),
        },
    )
}

pub fn migrate_data_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    if source == target {
        return Ok(());
    }
    if !source.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "source data directory does not exist",
        ));
    }
    let target_existed = target.exists();
    if target_existed && std::fs::read_dir(target)?.next().is_some() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target data directory is not empty",
        ));
    }
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            if let Err(copy_error) = copy_dir_contents(source, target) {
                let _ = std::fs::remove_dir_all(target);
                if target_existed {
                    let _ = std::fs::create_dir(target);
                }
                return Err(std::io::Error::new(
                    copy_error.kind(),
                    format!("could not move data directory: {rename_error}; {copy_error}"),
                ));
            }
            std::fs::remove_dir_all(source)
        }
    }
}

fn copy_dir_contents(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_contents(&source_path, &target_path)?;
        } else {
            std::fs::copy(source_path, target_path)?;
        }
    }
    Ok(())
}

pub fn read_connection_info(dir: &Path) -> Option<ConnectionInfo> {
    serde_json::from_slice(&std::fs::read(dir.join("daemon.json")).ok()?).ok()
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

    #[test]
    fn moves_the_complete_data_directory_and_rejects_existing_targets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let target = root.path().join("new");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested").join("history.db"), b"data").unwrap();

        migrate_data_dir(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(target.join("nested/history.db")).unwrap(),
            b"data"
        );
        assert_eq!(
            migrate_data_dir(&root.path().join("missing"), &root.path().join("another"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
        let second_source = root.path().join("second-old");
        std::fs::create_dir(&second_source).unwrap();
        let occupied = root.path().join("occupied");
        std::fs::create_dir(&occupied).unwrap();
        std::fs::write(occupied.join("keep.txt"), b"keep").unwrap();
        assert_eq!(
            migrate_data_dir(&second_source, &occupied)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert!(target.exists());
    }

    #[test]
    fn migrates_into_an_existing_empty_directory_selected_by_the_user() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let target = root.path().join("selected-empty-folder");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("settings.json"), b"settings").unwrap();
        std::fs::create_dir(&target).unwrap();

        migrate_data_dir(&source, &target).unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(target.join("settings.json")).unwrap(),
            b"settings"
        );
    }
}
pub mod files;
pub mod runtime_path;
pub mod subprocess_env;
