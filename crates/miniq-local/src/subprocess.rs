//! Background helpers must not allocate a Windows console. Redirecting stdio
//! alone does not prevent a console window when the daemon has no console.

use std::{ffi::OsStr, process::Command};

/// Construct a background command without changing its arguments, environment,
/// stdio or lifetime policy. Explicit system terminals and PTYs use their own
/// launchers instead.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        command
    };
    command
}

/// Async equivalent of [`command`].
pub fn async_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    command(program).into()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    const PROBE: &str = include_str!("../tests/fixtures/console_probe.ps1");

    fn assert_probe(output: std::process::Output) {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("miniq-no-console"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("miniq-stderr"));
    }

    #[test]
    fn synchronous_helpers_have_no_console_window_and_preserve_output() {
        assert_probe(
            command("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", PROBE])
                .output()
                .unwrap(),
        );
    }

    #[tokio::test]
    async fn asynchronous_helpers_have_no_console_window_and_preserve_output() {
        assert_probe(
            async_command("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", PROBE])
                .output()
                .await
                .unwrap(),
        );
    }
}
