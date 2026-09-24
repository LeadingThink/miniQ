//! Stable Windows entry point for an immutable, versioned terminal installation.
//! It stays unchanged during updates, so Windows executable locks cannot leave a
//! CLI from one release beside a daemon from another release.
use std::{env, fs, path::Path, process::Command};

fn payload(root: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    if !matches!(name, "miniq" | "miniq-daemon") {
        return Err("launch this program as miniq.exe or miniq-daemon.exe".into());
    }
    let version = fs::read_to_string(root.join(".miniq/current-version"))
        .map_err(|error| format!("cannot read installed version: {error}; rerun the installer"))?;
    let version = version.trim();
    if version.split('.').count() != 3
        || !version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("invalid installed version; rerun the installer".into());
    }
    Ok(root
        .join(".miniq/versions")
        .join(version)
        .join(format!("{name}.exe")))
}

fn run() -> Result<i32, String> {
    keep_launcher_until_child_exits()?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let root = executable
        .parent()
        .ok_or("missing installation directory")?;
    let name = executable
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("invalid launcher name")?;
    let executable = payload(root, name)?;
    let mut command = Command::new(executable);
    command.args(env::args_os().skip(1));
    #[cfg(windows)]
    if !has_console() {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW for desktop diagnostics.
    }
    let result = command
        .status()
        .map_err(|error| format!("cannot launch miniQ: {error}; rerun the installer"))?;
    Ok(result.code().unwrap_or(1))
}

#[cfg(windows)]
fn keep_launcher_until_child_exits() -> Result<(), String> {
    if !has_console() {
        return Ok(());
    }
    // A custom handler is not inherited by the child, unlike the NULL-handler
    // ignore flag. Let the real CLI handle Ctrl+C and await its final exit code.
    unsafe extern "system" fn handler(event: u32) -> i32 {
        i32::from(event == 0 || event == 1)
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(handler: unsafe extern "system" fn(u32) -> i32, add: i32) -> i32;
    }
    if unsafe { SetConsoleCtrlHandler(handler, 1) } == 0 {
        return Err(format!(
            "cannot register terminal signal handler: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn has_console() -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetConsoleCP() -> u32;
    }
    unsafe { GetConsoleCP() != 0 }
}

#[cfg(not(windows))]
fn keep_launcher_until_child_exits() -> Result<(), String> {
    Ok(())
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("miniQ: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_pair_from_one_pointer_and_rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".miniq")).unwrap();
        let pointer = dir.path().join(".miniq/current-version");
        fs::write(&pointer, "1.2.3\n").unwrap();
        for name in ["miniq", "miniq-daemon"] {
            assert_eq!(
                payload(dir.path(), name).unwrap(),
                dir.path().join(format!(".miniq/versions/1.2.3/{name}.exe"))
            );
        }
        for version in ["../../bad", "1.2.3/evil", "1.2", "1..3", "1.2.3\n4.5.6"] {
            fs::write(&pointer, version).unwrap();
            assert!(payload(dir.path(), "miniq").is_err());
        }
        assert!(payload(dir.path(), "other").is_err());
    }
}
