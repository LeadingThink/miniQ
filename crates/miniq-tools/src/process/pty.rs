//! PTY/ConPTY transport. Blocking terminal I/O runs off the async runtime.
use super::output::{Output, Spool};
use crate::ToolError;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
};

pub(super) struct Terminal {
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub input: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    pub pid: Option<u32>,
}
impl Drop for Terminal {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            super::force_kill_group(self.pid);
            let _ = self.child.kill();
        }
    }
}
pub(super) fn start(
    command: &str,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    rows: u16,
    cols: u16,
) -> Result<(Terminal, Output, Output), ToolError> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(failure)?;
    #[cfg(unix)]
    let mut cmd = {
        let mut c = CommandBuilder::new("sh");
        c.args(["-c", command]);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = CommandBuilder::new("powershell.exe");
        c.args(["-NoLogo", "-NoProfile", "-Command", command]);
        c
    };
    cmd.cwd(cwd);
    for (key, value) in env {
        cmd.env(key, value);
    }
    let stdout = Spool::new()?;
    let stderr = Spool::new()?;
    stderr.lock().unwrap().closed = true; // PTYs combine stdout/stderr.
    let reader = pair.master.try_clone_reader().map_err(failure)?;
    let writer = pair.master.take_writer().map_err(failure)?;
    let child = pair.slave.spawn_command(cmd).map_err(failure)?;
    let pid = child.process_id();
    drop(pair.slave);
    let output = stdout.clone();
    std::thread::spawn(move || collect(reader, output));
    Ok((
        Terminal {
            child,
            master: pair.master,
            input: Arc::new(Mutex::new(Some(writer))),
            pid,
        },
        stdout,
        stderr,
    ))
}
fn collect(mut reader: Box<dyn Read + Send>, output: Output) {
    let mut buffer = [0; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let error = output.lock().unwrap().append(&buffer[..n]).err();
                if let Some(error) = error {
                    output.lock().unwrap().error = Some(error.to_string());
                    break;
                }
            }
            // Unix PTYs may signal EOF with EIO after the slave closes.
            Err(error) => {
                #[cfg(unix)]
                if error.raw_os_error() == Some(libc::EIO) {
                    break;
                }
                output.lock().unwrap().error = Some(error.to_string());
                break;
            }
        }
    }
    output.lock().unwrap().closed = true;
}
fn failure(error: impl std::fmt::Display) -> ToolError {
    ToolError::ExecutionFailed(format!("PTY: {error}"))
}
