use std::path::PathBuf;

use tauri::AppHandle;

use super::{selected_application, FileOpenApplication};

pub async fn applications(
    _app: AppHandle,
    _file: PathBuf,
) -> Result<Vec<FileOpenApplication>, String> {
    // No reliable portable handler enumeration. The existing default opener
    // remains available independently of this list.
    Ok(Vec::new())
}

pub async fn open(app: AppHandle, file: PathBuf, id: String) -> Result<(), String> {
    selected_application(&applications(app, file).await?, &id)?;
    Err("当前系统不支持指定应用打开文件".into())
}
