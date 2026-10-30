use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tokio::process::Child;
#[cfg(windows)]
mod windows;

pub(super) struct Launch {
    pub child: Option<Child>,
    pub log: PathBuf,
}

impl Launch {
    pub fn start(directory: &Path, mut command: Command) -> io::Result<Self> {
        let logs = directory.join("logs");
        std::fs::create_dir_all(&logs)?;
        let (mut file, log) = tempfile::Builder::new()
            .prefix("daemon-start-")
            .suffix(".log")
            .tempfile_in(logs)?
            .keep()
            .map_err(|error| error.error)?;
        let workdir = directory.join("runtime");
        std::fs::create_dir_all(&workdir)?;
        let binary = command.get_program().to_string_lossy().into_owned();
        writeln!(
            file,
            "[miniq] Starting {binary}; client version {}",
            env!("CARGO_PKG_VERSION")
        )?;
        detach(&mut command, &mut file)?;
        command
            .current_dir(workdir)
            .env("MINIQ_DATA_DIR", directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(file);
        let child = tokio::process::Command::from(command)
            .spawn()
            .map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("无法启动后台 {binary}：{error}；日志：{}", log.display()),
                )
            })?;
        Ok(Self {
            child: Some(child),
            log,
        })
    }

    pub fn check_exit(&mut self) -> io::Result<()> {
        if let Some(status) = self.child.as_mut().expect("launch owns child").try_wait()? {
            return Err(io::Error::other(format!(
                "miniQ 后台启动后提前退出（{status}），请查看日志：{}",
                self.log.display()
            )));
        }
        Ok(())
    }

    pub async fn cancel(&mut self) -> io::Result<()> {
        let child = self.child.as_mut().expect("launch owns child");
        child.kill().await
    }
}

impl Drop for Launch {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Startup timeout leaves a verified long initialization running, but never a zombie.
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
}

fn detach(command: &mut Command, _log: &mut File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(windows)]
    {
        windows::detach(command, _log)?;
    }
    Ok(())
}

pub(super) fn operation_file(directory: &Path) -> io::Result<(File, PathBuf)> {
    let absolute = std::path::absolute(directory)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| io::Error::other("data directory needs a parent"))?;
    std::fs::create_dir_all(parent)?;
    let directory = if absolute.exists() {
        std::fs::canonicalize(&absolute)?
    } else {
        std::fs::canonicalize(parent)?.join(
            absolute
                .file_name()
                .ok_or_else(|| io::Error::other("data directory needs a name"))?,
        )
    };
    // Keep the operation lock outside movable data, so a directory migration cannot
    // unlink the lock and let another client acquire a newly created lock file.
    let mut name = directory
        .file_name()
        .ok_or_else(|| io::Error::other("data directory needs a name"))?
        .to_os_string();
    name.push(".daemon-lifecycle.lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.with_file_name(name))?;
    Ok((file, directory))
}
