//! Native actions for authorized file links in a conversation.
use std::path::{Path, PathBuf};

use miniq_local::files::{validated_target_with_authorization, LocalTarget};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::file_link_apps::{self, FileOpenApplication};

fn validated_source(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<PathBuf, String> {
    match validated_target_with_authorization(
        path,
        workspace_path,
        workspace_paths,
        authorized_files,
    )? {
        LocalTarget::File(file) => Ok(file),
        LocalTarget::Directory(directory) => Err(format!("目标不是文件: {}", directory.display())),
    }
}

/// Stage the complete binary copy beside the destination before replacing it.
/// This also protects the source if the destination is another hard link to it.
fn copy_to_destination(
    source: &Path,
    destination: Option<PathBuf>,
) -> Result<Option<String>, String> {
    let Some(destination) = destination else {
        return Ok(None);
    };
    let source = dunce::canonicalize(source).map_err(|error| format!("无法访问源文件: {error}"))?;
    if !source.is_file() {
        return Err("目标不是文件".into());
    }
    let result = destination.to_string_lossy().into_owned();
    if dunce::canonicalize(&destination).is_ok_and(|target| target == source) {
        return Ok(Some(result));
    }

    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "保存位置必须包含目录".to_string())?;
    let mut input =
        std::fs::File::open(&source).map_err(|error| format!("无法读取源文件: {error}"))?;
    let mut copy = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法在所选目录创建文件: {error}"))?;
    std::io::copy(&mut input, copy.as_file_mut())
        .map_err(|error| format!("无法复制文件: {error}"))?;
    copy.persist(&destination)
        .map_err(|error| format!("无法保存文件: {}", error.error))?;
    Ok(Some(result))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_local_file_as(
    app: AppHandle,
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
    authorized_files: Vec<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = validated_source(&path, &workspace_path, &workspace_paths, &authorized_files)?;
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "无法读取源文件名".to_string())?;
        // The dialog plugin dispatches native UI to the appropriate platform
        // thread. Its blocking API must run outside Tauri's main thread.
        let picked = app
            .dialog()
            .file()
            .set_file_name(file_name)
            .blocking_save_file();
        let Some(picked) = picked else {
            return copy_to_destination(&source, None);
        };
        let destination = picked
            .into_path()
            .map_err(|error| format!("无法使用所选位置: {error}"))?;
        // A dialog may stay open while the workspace or a symlink changes.
        let source = validated_source(&path, &workspace_path, &workspace_paths, &authorized_files)?;
        copy_to_destination(&source, Some(destination))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn file_open_applications(
    app: AppHandle,
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
    authorized_files: Vec<String>,
) -> Result<Vec<FileOpenApplication>, String> {
    let file = tauri::async_runtime::spawn_blocking(move || {
        validated_source(&path, &workspace_path, &workspace_paths, &authorized_files)
    })
    .await
    .map_err(|error| error.to_string())??;
    file_link_apps::applications(app, file).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_local_file_with(
    app: AppHandle,
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
    authorized_files: Vec<String>,
    application_id: String,
) -> Result<(), String> {
    let file = tauri::async_runtime::spawn_blocking(move || {
        validated_source(&path, &workspace_path, &workspace_paths, &authorized_files)
    })
    .await
    .map_err(|error| error.to_string())??;
    // Each platform queries the current handlers again before launching.
    file_link_apps::open(app, file, application_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PDF: &[u8] = b"%PDF-1.7\r\n%\xe2\xe3\xcf\xd3\n1 0 obj\0\xff\x80\n%%EOF\n";

    #[test]
    fn copies_pdf_bytes_without_text_conversion() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("原始.pdf");
        let destination = directory.path().join("副本.pdf");
        std::fs::write(&source, PDF).unwrap();
        std::fs::write(&destination, b"old destination").unwrap();

        assert_eq!(
            copy_to_destination(&source, Some(destination.clone())).unwrap(),
            Some(destination.to_string_lossy().into_owned())
        );
        assert_eq!(std::fs::read(&source).unwrap(), PDF);
        assert_eq!(std::fs::read(&destination).unwrap(), PDF);
    }

    #[test]
    fn saving_to_source_does_not_truncate_it() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        std::fs::write(&source, PDF).unwrap();
        copy_to_destination(&source, Some(source.clone())).unwrap();
        assert_eq!(std::fs::read(source).unwrap(), PDF);
    }

    #[test]
    fn saving_to_a_hard_link_does_not_truncate_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        let destination = directory.path().join("linked.pdf");
        std::fs::write(&source, PDF).unwrap();
        std::fs::hard_link(&source, &destination).unwrap();
        copy_to_destination(&source, Some(destination.clone())).unwrap();
        assert_eq!(std::fs::read(source).unwrap(), PDF);
        assert_eq!(std::fs::read(destination).unwrap(), PDF);
    }

    #[test]
    fn cancellation_does_not_copy_or_modify_the_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        std::fs::write(&source, PDF).unwrap();
        assert_eq!(copy_to_destination(&source, None).unwrap(), None);
        assert_eq!(std::fs::read(source).unwrap(), PDF);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_unauthorized_files_and_directories() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("outside.pdf");
        std::fs::write(&file, PDF).unwrap();
        let root = workspace.path().to_str().unwrap();
        assert!(validated_source(file.to_str().unwrap(), root, &[], &[]).is_err());
        assert!(validated_source(root, root, &[], &[]).is_err());
    }

    #[test]
    fn accepts_attached_roots_and_explicitly_authorized_files() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("authorized.pdf");
        std::fs::write(&file, PDF).unwrap();
        let root = workspace.path().to_str().unwrap();
        let path = file.to_str().unwrap();
        assert!(validated_source(
            path,
            root,
            &[outside.path().to_string_lossy().into_owned()],
            &[]
        )
        .is_ok());
        assert!(validated_source(path, root, &[], &[path.to_string()]).is_ok());
    }
    // Native save-dialog presentation and cancellation still need a desktop
    // smoke test. The cancellation branch after the dialog is covered above.
}
