//! PTY/ConPTY transport. Blocking terminal I/O runs off the async runtime.
use super::output::{Output, Spool};
use crate::ToolError;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
#[cfg(windows)]
use std::sync::Weak;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
};

type TerminalInput = Arc<Mutex<Option<Box<dyn Write + Send>>>>;

pub(super) struct Terminal {
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub input: TerminalInput,
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
    stderr.lock().unwrap().finish(); // PTYs combine stdout/stderr.
    let reader = pair.master.try_clone_reader().map_err(failure)?;
    let writer = pair.master.take_writer().map_err(failure)?;
    let child = pair.slave.spawn_command(cmd).map_err(failure)?;
    let pid = child.process_id();
    drop(pair.slave);
    let input = Arc::new(Mutex::new(Some(writer)));
    #[cfg(windows)]
    let cursor_input = Arc::downgrade(&input);
    let output = stdout.clone();
    std::thread::spawn(move || {
        collect(
            reader,
            output,
            #[cfg(windows)]
            cursor_input,
        )
    });
    Ok((
        Terminal {
            child,
            master: pair.master,
            input,
            pid,
        },
        stdout,
        stderr,
    ))
}
fn collect(
    mut reader: Box<dyn Read + Send>,
    output: Output,
    #[cfg(windows)] input: Weak<Mutex<Option<Box<dyn Write + Send>>>>,
) {
    let mut buffer = [0; 8192];
    #[cfg(windows)]
    let mut cursor = StartupCursor::default();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                #[cfg(windows)]
                let (bytes, reply) = cursor.consume(&buffer[..n]);
                #[cfg(windows)]
                let bytes = bytes.as_slice();
                #[cfg(not(windows))]
                let bytes = &buffer[..n];
                #[cfg(windows)]
                let reply_error = reply
                    .then(|| reply_to_startup_cursor(&input))
                    .and_then(Result::err);
                let append_error = output.lock().unwrap().append(bytes).err();
                #[cfg(windows)]
                let error = reply_error.or(append_error);
                #[cfg(not(windows))]
                let error = append_error;
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
    #[cfg(windows)]
    {
        let error = output.lock().unwrap().append(cursor.pending()).err();
        if let Some(error) = error {
            output.lock().unwrap().error = Some(error.to_string());
        }
    }
    output.lock().unwrap().finish();
}
#[cfg(windows)]
fn reply_to_startup_cursor(
    input: &Weak<Mutex<Option<Box<dyn Write + Send>>>>,
) -> std::io::Result<()> {
    let input = input.upgrade().ok_or(std::io::ErrorKind::BrokenPipe)?;
    let mut input = input.lock().unwrap();
    let writer = input.as_mut().ok_or(std::io::ErrorKind::BrokenPipe)?;
    writer.write_all(b"\x1b[1;1R")?;
    writer.flush()
}

// portable-pty enables PSEUDOCONSOLE_INHERIT_CURSOR. ConPTY waits for this
// startup cursor report even when no UI is watching the terminal. Consume only
// its first query so xterm cannot send a duplicate reply into the child's stdin.
#[cfg(any(windows, test))]
#[derive(Default)]
struct StartupCursor {
    matched: usize,
    answered: bool,
}
#[cfg(any(windows, test))]
impl StartupCursor {
    const QUERY: &'static [u8] = b"\x1b[6n";

    fn consume(&mut self, bytes: &[u8]) -> (Vec<u8>, bool) {
        let mut output = Vec::with_capacity(bytes.len() + self.matched);
        let mut reply = false;
        for &byte in bytes {
            if self.answered {
                output.push(byte);
            } else if byte == Self::QUERY[self.matched] {
                self.matched += 1;
                if self.matched == Self::QUERY.len() {
                    self.matched = 0;
                    self.answered = true;
                    reply = true;
                }
            } else {
                output.extend_from_slice(self.pending());
                self.matched = usize::from(byte == Self::QUERY[0]);
                if self.matched == 0 {
                    output.push(byte);
                }
            }
        }
        (output, reply)
    }

    fn pending(&self) -> &[u8] {
        &Self::QUERY[..self.matched]
    }
}

#[cfg(test)]
mod tests {
    use super::StartupCursor;

    #[test]
    fn startup_cursor_query_is_answered_once_across_every_read_boundary() {
        let source = b"before\x1b[6nafter\x1b[6n\xff\0";
        let expected = b"beforeafter\x1b[6n\xff\0";
        for page_size in 1..=source.len() {
            let mut cursor = StartupCursor::default();
            let mut output = Vec::new();
            let mut replies = 0;
            for page in source.chunks(page_size) {
                let (bytes, reply) = cursor.consume(page);
                output.extend(bytes);
                replies += usize::from(reply);
            }
            output.extend(cursor.pending());
            assert_eq!(output, expected, "page_size={page_size}");
            assert_eq!(replies, 1, "page_size={page_size}");
        }
    }

    #[test]
    fn unrecognized_and_incomplete_cursor_queries_preserve_every_byte() {
        for source in [
            b"\x1b\x1b[6".as_slice(),
            b"\x1b[31mred\x1b[0m\x1b[",
            b"\xff\0",
        ] {
            let mut cursor = StartupCursor::default();
            let mut output = Vec::new();
            for byte in source {
                let (bytes, reply) = cursor.consume(&[*byte]);
                output.extend(bytes);
                assert!(!reply);
            }
            output.extend(cursor.pending());
            assert_eq!(output, source);
        }
    }
}
fn failure(error: impl std::fmt::Display) -> ToolError {
    ToolError::ExecutionFailed(format!("PTY: {error}"))
}
