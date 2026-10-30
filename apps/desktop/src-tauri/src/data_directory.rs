use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::daemon::DaemonLifecycle;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryInfo {
    path: String,
    managed_by_environment: bool,
}

pub async fn choose_and_migrate(
    app: AppHandle,
    state: std::sync::Arc<DaemonLifecycle>,
) -> Result<String, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "用户取消了目录选择".to_owned())?
    .into_path()
    .map_err(|error| format!("无法使用所选目录: {error}"))?;

    let current = miniq_local::configured_data_dir();
    if miniq_local::data_dir_is_managed_by_environment() {
        return Err("当前数据目录由 MINIQ_DATA_DIR 环境变量管理".to_owned());
    }
    if same_path(&current, &picked) {
        return Ok(current.to_string_lossy().into_owned());
    }
    if picked.starts_with(&current) {
        return Err("新数据目录不能位于当前数据目录内".to_owned());
    }

    state.migrate_to(picked.clone()).await?;
    Ok(picked.to_string_lossy().into_owned())
}

fn same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

pub fn current() -> DataDirectoryInfo {
    DataDirectoryInfo {
        path: miniq_local::configured_data_dir()
            .to_string_lossy()
            .into_owned(),
        managed_by_environment: miniq_local::data_dir_is_managed_by_environment(),
    }
}
