//! Desktop entry point for the same reviewed installer used by terminal users.
//! Installation replaces the installed binary pair without touching the daemon.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Mutex;

static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatus {
    path: String,
    installed: bool,
    version: Option<String>,
    version_error: Option<String>,
    desktop_version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInstallResult {
    status: TerminalStatus,
    log: String,
}

fn install_directory() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let (variable, suffix) = ("LOCALAPPDATA", "miniQ/bin");
    #[cfg(not(windows))]
    let (variable, suffix) = ("HOME", ".local/bin");
    let base = std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("无法读取 {variable}，请在终端中安装 miniQ"))?;
    let base = PathBuf::from(base);
    if !base.is_absolute() {
        return Err(format!("{variable} 不是绝对路径，无法确定终端安装位置"));
    }
    Ok(base.join(suffix))
}

fn configure_process(command: &mut Command) {
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

async fn read_version(executable: &Path) -> Result<String, String> {
    let mut command = Command::new(executable);
    configure_process(&mut command);
    command.arg("--version");
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "读取终端版本超时，可重新安装终端命令".to_owned())?
        .map_err(|error| format!("无法运行终端命令：{error}"))?;
    if !output.status.success() {
        return Err(format!("终端版本检查失败：{}", output.status));
    }
    let version =
        String::from_utf8(output.stdout).map_err(|_| "终端版本信息不是有效文本".to_owned())?;
    let version = version.trim();
    if version.is_empty() {
        return Err("终端版本信息为空，可重新安装终端命令".to_owned());
    }
    Ok(version.to_owned())
}

async fn status_in(directory: &Path) -> TerminalStatus {
    let path = directory.join(if cfg!(windows) { "miniq.exe" } else { "miniq" });
    let installed = path.is_file();
    let (version, version_error) = if installed {
        match read_version(&path).await {
            Ok(version) => (Some(version), None),
            Err(error) => (None, Some(error)),
        }
    } else {
        (None, None)
    };
    TerminalStatus {
        path: path.to_string_lossy().into_owned(),
        installed,
        version,
        version_error,
        desktop_version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
pub async fn terminal_install_status() -> Result<TerminalStatus, String> {
    Ok(status_in(&install_directory()?).await)
}

fn installer_process(script: &Path, directory: &Path) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new("/bin/sh");
    command.arg(script);
    command.env("MINIQ_INSTALL_DIR", directory);
    command.env_remove("MINIQ_VERSION");
    command.env_remove("MINIQ_NO_MODIFY_PATH");
    configure_process(&mut command);
    command
}

#[tauri::command]
pub async fn install_terminal_command() -> Result<TerminalInstallResult, String> {
    let _guard = INSTALL_LOCK
        .try_lock()
        .map_err(|_| "终端命令正在安装，请等待当前安装完成".to_owned())?;
    let directory = install_directory()?;
    let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let (name, source) = (
        "install.ps1",
        include_str!("../../../../scripts/install-cli.ps1"),
    );
    #[cfg(not(windows))]
    let (name, source) = (
        "install.sh",
        include_str!("../../../../scripts/install-cli.sh"),
    );
    let script = temporary.path().join(name);
    std::fs::write(&script, source).map_err(|error| format!("无法准备终端安装程序：{error}"))?;
    let output = installer_process(&script, &directory)
        .output()
        .await
        .map_err(|error| format!("无法启动终端安装程序：{error}"))?;
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(format!("终端安装失败（{}）：\n{log}", output.status));
    }
    let status = status_in(&directory).await;
    if !status.installed || status.version.is_none() {
        return Err(format!("安装程序已结束，但终端命令未通过版本检查。\n{log}"));
    }
    Ok(TerminalInstallResult { status, log })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_installation_is_reported_without_starting_a_daemon() {
        let directory = tempfile::tempdir().unwrap();
        let status = status_in(directory.path()).await;
        assert!(!status.installed);
        assert!(status.version.is_none());
        assert!(status.version_error.is_none());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn status_only_invokes_the_cli_version_flag_and_never_the_daemon() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("miniq");
        std::fs::write(&binary, "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 42\nprintf 'miniq 1.2.3\\n'\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let status = status_in(directory.path()).await;
        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("miniq 1.2.3"));
        assert!(status.version_error.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn installer_executes_a_private_script_with_literal_paths() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("space and 'quote/$value");
        let script = directory.path().join("installer with spaces.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' \"$MINIQ_INSTALL_DIR\"\n[ -z \"$MINIQ_VERSION\" ] && [ -z \"$MINIQ_NO_MODIFY_PATH\" ]\n",
        ).unwrap();
        let output = installer_process(&script, &target).output().await.unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            target.to_str().unwrap()
        );
        assert!(!target.exists());
    }

    #[test]
    fn installer_paths_are_arguments_instead_of_shell_interpolation() {
        let directory = Path::new("/tmp/space and 'quote/$value");
        let script = directory.join("install.sh");
        let command = installer_process(&script, directory);
        assert!(command
            .as_std()
            .get_args()
            .any(|argument| argument == script.as_os_str()));
        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == "MINIQ_INSTALL_DIR"
                    && value == Some(directory.as_os_str()))
        );
    }
}
