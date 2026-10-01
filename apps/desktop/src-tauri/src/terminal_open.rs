//! Opens the system terminal in a workspace directory — the workbench
//! launcher's "终端" entry (miniQ has no embedded terminal).

use std::path::{Path, PathBuf};
use std::process::Command;

fn workspace_directory(directory: &str) -> Result<PathBuf, String> {
    if directory.trim().is_empty() {
        return Err("当前会话没有工作区目录".into());
    }
    let path = Path::new(directory)
        .canonicalize()
        .map_err(|error| format!("无法访问工作区目录 {directory}: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{directory} 不是目录"));
    }
    Ok(path)
}

#[tauri::command]
pub fn open_terminal(directory: String) -> Result<(), String> {
    let dir = workspace_directory(&directory)?;
    spawn(&dir)
}

#[cfg(target_os = "macos")]
fn spawn(dir: &Path) -> Result<(), String> {
    Command::new("open")
        .args(["-a", "Terminal"])
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开终端：{error}"))
}

#[cfg(target_os = "windows")]
fn spawn(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    Command::new("cmd")
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开终端：{error}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn spawn(dir: &Path) -> Result<(), String> {
    for program in [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "xterm",
    ] {
        if Command::new(program).current_dir(dir).spawn().is_ok() {
            return Ok(());
        }
    }
    Err("未找到可用的终端程序".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_or_file_paths() {
        assert!(workspace_directory("").is_err());
        assert!(workspace_directory("/definitely/not/here/miniq").is_err());
        let file = std::env::temp_dir().join("miniq-terminal-open-test.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(workspace_directory(file.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(file);
        assert!(workspace_directory(std::env::temp_dir().to_str().unwrap()).is_ok());
    }
}
