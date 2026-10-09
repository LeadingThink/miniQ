use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAX_EXPORT_BYTES: usize = 200 * 1024 * 1024;

/// Paths the user picked in a save dialog during this run. Only these can be
/// revealed afterwards, so the webview cannot reveal arbitrary paths.
#[derive(Default)]
pub struct ExportedFiles(Mutex<HashSet<PathBuf>>);

fn valid_extension(extension: &str) -> bool {
    !extension.is_empty()
        && extension.len() <= 10
        && extension.chars().all(|c| c.is_ascii_alphanumeric())
}

fn with_extension(path: PathBuf, extension: &str) -> PathBuf {
    let matches = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension));
    if matches {
        path
    } else {
        let mut name = path.into_os_string();
        name.push(format!(".{extension}"));
        PathBuf::from(name)
    }
}

/// Asks the user where to save, writes the contents and returns the final
/// path. Returns `None` when the user cancels the dialog.
pub async fn save(
    app: AppHandle,
    files: &ExportedFiles,
    file_name: String,
    extension: String,
    filter_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    if !valid_extension(&extension) {
        return Err("导出文件类型无效".to_string());
    }
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("导出内容超过 200 MB".to_string());
    }
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(file_name)
            .add_filter(filter_name, &[extension.as_str()])
            .blocking_save_file()
            .map(|path| (path, extension))
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some((picked, extension)) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("无法使用所选位置: {error}"))?;
    let path = with_extension(path, &extension);
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, contents))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("无法写入文件: {error}"))?;
    files
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub fn reveal(app: &AppHandle, files: &ExportedFiles, path: &str) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !files.0.lock().map_err(|e| e.to_string())?.contains(&path) {
        return Err("只能定位本次导出的文件".to_string());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_or_appends_the_requested_extension() {
        assert_eq!(
            with_extension(PathBuf::from("/tmp/a.md"), "md"),
            PathBuf::from("/tmp/a.md")
        );
        assert_eq!(
            with_extension(PathBuf::from("/tmp/a.MD"), "md"),
            PathBuf::from("/tmp/a.MD")
        );
        assert_eq!(
            with_extension(PathBuf::from("/tmp/renamed"), "json"),
            PathBuf::from("/tmp/renamed.json")
        );
        assert_eq!(
            with_extension(PathBuf::from("/tmp/v1.2"), "md"),
            PathBuf::from("/tmp/v1.2.md")
        );
    }

    #[test]
    fn rejects_unsafe_extensions() {
        assert!(valid_extension("md"));
        assert!(valid_extension("json"));
        assert!(!valid_extension(""));
        assert!(!valid_extension("../x"));
        assert!(!valid_extension("m d"));
    }
}
