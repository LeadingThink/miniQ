use super::*;

#[test]
fn missing_pid_is_not_accepted_as_an_exited_daemon() {
    assert!(DaemonProcess::open(0).is_err());
    assert!(DaemonProcess::open(u32::MAX).is_err());
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::{Child, Command, Stdio};

    struct Fixture(Child);

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn start_daemon(directory: &Path) -> Fixture {
        std::fs::create_dir_all(directory).unwrap();
        let binary = directory.join("miniq-daemon.exe");
        let system = std::env::var("SystemRoot").unwrap();
        std::fs::copy(Path::new(&system).join("System32/ping.exe"), &binary).unwrap();
        Fixture(
            Command::new(binary)
                .args(["-t", "127.0.0.1"])
                .creation_flags(0x0800_0000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }

    #[test]
    fn waits_for_process_exit_even_without_a_health_server() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = start_daemon(directory.path());
        let process = DaemonProcess::open(child.0.id()).unwrap();
        assert!(process.wait(Duration::from_millis(1)).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        process.wait(Duration::from_secs(1)).unwrap();
        // The captured handle remains valid after the process has disappeared.
        process.wait(Duration::ZERO).unwrap();
    }

    #[test]
    fn installer_stops_only_daemons_in_the_target_installation() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("install ' quoted & path");
        let other = directory.path().join("other installation");
        let mut target_child = start_daemon(&target);
        let mut other_child = start_daemon(&other);
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("installer/stop-daemon.ps1");
        let result = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .arg("-InstallDir")
            .arg(&target)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(target_child.0.try_wait().unwrap().is_some());
        assert!(other_child.0.try_wait().unwrap().is_none());
        std::fs::write(target.join("miniq-daemon.exe"), b"replacement").unwrap();
    }

    #[test]
    #[ignore = "requires MINIQ_MAKENSIS, MINIQ_NSIS_UTILS and MINIQ_NSIS_PLUGINS"]
    fn compiled_installer_hook_releases_the_executable() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target installation");
        let mut target_child = start_daemon(&target);
        let mut other_child = start_daemon(&directory.path().join("other installation"));
        let installer_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("installer");
        let output = directory.path().join("installer.exe");
        let built = Command::new(std::env::var("MINIQ_MAKENSIS").unwrap())
            .arg("/V2")
            .arg(format!(
                "/DTAURI_UTILS={}",
                std::env::var("MINIQ_NSIS_UTILS").unwrap()
            ))
            .arg(format!(
                "/DTAURI_PLUGINS={}",
                std::env::var("MINIQ_NSIS_PLUGINS").unwrap()
            ))
            .arg(format!(
                "/DHOOK_PATH={}",
                installer_dir.join("hooks.nsh").display()
            ))
            .arg(format!("/DTEST_OUTPUT={}", output.display()))
            .arg(installer_dir.join("tests/hook.nsi"))
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "{}{}",
            String::from_utf8_lossy(&built.stdout),
            String::from_utf8_lossy(&built.stderr)
        );
        let installed = Command::new(output)
            .arg("/S")
            // NSIS requires /D to be the final, unquoted command-line argument.
            .raw_arg(format!("/D={}", target.display()))
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(installed.status.success());
        assert!(target_child.0.try_wait().unwrap().is_some());
        assert!(other_child.0.try_wait().unwrap().is_none());
        std::fs::write(target.join("miniq-daemon.exe"), b"replacement").unwrap();
    }
}
