//! Cross-process coordination for foreground and application-scoped control.

use std::{fs::File, path::Path};

fn lock(root: &Path, name: &str, shared: bool) -> Result<File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(root.join(name))
        .map_err(|error| error.to_string())?;
    let result = if shared {
        file.try_lock_shared()
    } else {
        file.try_lock()
    };
    result
        .map_err(|_| "another miniQ task or process owns this control target; wait for release")?;
    Ok(file)
}

#[cfg(any(feature = "desktop", test))]
pub(crate) fn foreground(root: &Path) -> Result<File, String> {
    lock(root, "miniq-desktop-input.lock", false)
}

pub(crate) fn background(root: &Path, pid: i32) -> Result<(File, File), String> {
    let desktop = lock(root, "miniq-desktop-input.lock", true)?;
    let app = lock(root, &format!("miniq-app-input-{pid}.lock"), false)?;
    Ok((desktop, app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_apps_share_desktop_but_not_targets_or_foreground_control() {
        let directory = tempfile::tempdir().unwrap();
        let first = background(directory.path(), 11).unwrap();
        let second = background(directory.path(), 12).unwrap();
        assert!(background(directory.path(), 11).is_err());
        assert!(foreground(directory.path()).is_err());
        drop((first, second));
        let foreground = foreground(directory.path()).unwrap();
        assert!(background(directory.path(), 11).is_err());
        drop(foreground);
        assert!(background(directory.path(), 11).is_ok());
    }
}
