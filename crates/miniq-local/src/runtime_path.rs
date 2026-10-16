//! PATH discovery for desktop-launched daemons. Only PATH is imported.
use std::ffi::OsString;

#[derive(Debug, Clone)]
pub struct PathResolution {
    pub path: Option<OsString>,
    pub diagnostic: Option<String>,
}

/// The caller caches this result for the desktop process lifetime.
pub fn resolve() -> PathResolution {
    let inherited = std::env::var_os("PATH");
    #[cfg(unix)]
    {
        let shell = std::env::var_os("SHELL").filter(|shell| !shell.is_empty());
        let result = shell
            .ok_or_else(|| "SHELL is not set".to_owned())
            .and_then(|shell| {
                let mut command = std::process::Command::new(shell);
                command.args(["-ilc", unix::SCRIPT]);
                unix::capture(&mut command, std::time::Duration::from_secs(2))
            });
        match result {
            Ok(path) => PathResolution {
                path: Some(path),
                diagnostic: None,
            },
            Err(error) => PathResolution {
                path: inherited,
                diagnostic: Some(error),
            },
        }
    }
    #[cfg(not(unix))]
    PathResolution {
        path: inherited,
        diagnostic: None,
    }
}

#[cfg(unix)]
mod unix {
    use std::{
        ffi::OsString,
        io::{Read, Seek},
        os::unix::{ffi::OsStringExt, process::CommandExt},
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    // printenv preserves fish's exported colon-separated PATH as well as POSIX
    // shell PATH. NUL framing isolates startup messages without trimming paths.
    pub(super) const SCRIPT: &str =
        "printf '\\000MINIQ_PATH\\000'; /usr/bin/printenv PATH; printf '\\000MINIQ_END\\000'";
    const BEGIN: &[u8] = b"\0MINIQ_PATH\0";
    const END: &[u8] = b"\0MINIQ_END\0";

    struct Probe(Child);
    impl Drop for Probe {
        fn drop(&mut self) {
            // The probe owns a new process group; stop descendants even if the
            // shell exited first. Never wait for inherited stdout pipe handles.
            unsafe {
                libc::killpg(self.0.id() as i32, libc::SIGKILL);
            }
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    pub(super) fn capture(command: &mut Command, timeout: Duration) -> Result<OsString, String> {
        // A file avoids pipe deadlocks and streams noisy shell initialization
        // to disk rather than accumulating it in memory while it runs.
        let mut output = tempfile::tempfile().map_err(|error| error.to_string())?;
        command
            .stdin(Stdio::null())
            .stdout(output.try_clone().map_err(|error| error.to_string())?)
            .stderr(Stdio::null())
            .process_group(0);
        let mut probe = Probe(
            command
                .spawn()
                .map_err(|error| format!("could not start shell: {error}"))?,
        );
        let deadline = Instant::now() + timeout;
        loop {
            let status = probe.0.try_wait().map_err(|error| error.to_string())?;
            if let Some(status) = status {
                if !status.success() {
                    return Err(format!("shell exited with {status}"));
                }
                break;
            }
            if Instant::now() >= deadline {
                return Err("shell PATH lookup timed out".to_owned());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(probe);
        output.rewind().map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        output
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        extract_path(&bytes).ok_or_else(|| "shell did not return a nonempty PATH".to_owned())
    }

    fn extract_path(output: &[u8]) -> Option<OsString> {
        let start = output
            .windows(BEGIN.len())
            .rposition(|part| part == BEGIN)?
            + BEGIN.len();
        let finish = start
            + output[start..]
                .windows(END.len())
                .position(|part| part == END)?;
        // Remove exactly the newline printenv appends, preserving literal
        // whitespace/newlines and non-UTF-8 bytes belonging to directory names.
        let path = output[start..finish].strip_suffix(b"\n")?;
        (!path.is_empty()).then(|| OsString::from_vec(path.to_vec()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::ffi::OsStrExt;

        #[test]
        fn preserves_path_bytes_and_ignores_startup_noise() {
            let path = b" /tools/\xff\n:/usr/bin\n";
            let output = [
                b"startup log\n".as_slice(),
                BEGIN,
                path,
                b"\n",
                END,
                b"logout log",
            ]
            .concat();
            assert_eq!(extract_path(&output).unwrap().as_bytes(), path);
            assert!(extract_path(b"unframed").is_none());
            assert!(extract_path(&[BEGIN, b"\n", END].concat()).is_none());
        }

        #[test]
        fn imports_only_exported_path() {
            let mut command = Command::new("/bin/sh");
            command.args([
                "-c",
                &format!("export PATH='/custom tools:/usr/bin'; export EXTRA=private; {SCRIPT}"),
            ]);
            assert_eq!(
                capture(&mut command, Duration::from_secs(2)).unwrap(),
                "/custom tools:/usr/bin"
            );
        }

        #[test]
        fn login_shell_reads_user_configuration() {
            let home = tempfile::tempdir().unwrap();
            #[cfg(target_os = "macos")]
            let (shell, file, extra) = ("/bin/zsh", ".zshrc", "ZDOTDIR");
            #[cfg(not(target_os = "macos"))]
            let (shell, file, extra) = ("/bin/bash", ".bash_profile", "HOME");
            std::fs::write(
                home.path().join(file),
                "export PATH='/miniq-test-tools:/usr/bin'\n",
            )
            .unwrap();
            let mut command = Command::new(shell);
            command
                .env("HOME", home.path())
                .env(extra, home.path())
                .args(["-ilc", SCRIPT]);
            assert_eq!(
                capture(&mut command, Duration::from_secs(2)).unwrap(),
                "/miniq-test-tools:/usr/bin"
            );
        }

        #[test]
        fn timeout_and_background_stdout_cannot_block_startup() {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "sleep 30 & wait"]);
            let start = Instant::now();
            assert!(capture(&mut command, Duration::from_millis(100))
                .unwrap_err()
                .contains("timed out"));
            assert!(start.elapsed() < Duration::from_secs(2));
            let mut command = Command::new("/bin/sh");
            command.args(["-c", &format!("sleep 30 & {SCRIPT}")]);
            let start = Instant::now();
            assert!(capture(&mut command, Duration::from_secs(2)).is_ok());
            assert!(start.elapsed() < Duration::from_secs(2));
        }

        #[test]
        fn failures_are_reported() {
            assert!(capture(
                &mut Command::new("/missing/miniq-shell"),
                Duration::from_secs(1)
            )
            .is_err());
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "exit 9"]);
            assert!(capture(&mut command, Duration::from_secs(1))
                .unwrap_err()
                .contains("9"));
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn windows_preserves_process_path() {
        let result = super::resolve();
        assert_eq!(result.path, std::env::var_os("PATH"));
        assert!(result.diagnostic.is_none());
    }
}
