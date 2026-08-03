use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextFile {
    path: String,
    content: String,
}

fn validated_file(path: &str, workspace_path: &str) -> Result<PathBuf, String> {
    let workspace = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| format!("无法访问工作区 {workspace_path}: {error}"))?;
    if !workspace.is_dir() {
        return Err(format!("工作区不是目录: {}", workspace.display()));
    }

    let file = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("无法访问文件 {path}: {error}"))?;
    if !file.is_file() {
        return Err(format!("目标不是文件: {}", file.display()));
    }
    if !file.starts_with(&workspace) {
        return Err(format!("拒绝打开工作区外的文件: {}", file.display()));
    }
    Ok(file)
}

pub fn open(app: &AppHandle, path: &str, workspace_path: &str) -> Result<(), String> {
    let file = validated_file(path, workspace_path)?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn reveal(app: &AppHandle, path: &str, workspace_path: &str) -> Result<(), String> {
    let file = validated_file(path, workspace_path)?;
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|error| error.to_string())
}

pub fn read_text(path: &str, workspace_path: &str) -> Result<LocalTextFile, String> {
    let file = validated_file(path, workspace_path)?;
    let content = std::fs::read_to_string(&file)
        .map_err(|error| format!("无法读取 UTF-8 文本文件 {}: {error}", file.display()))?;
    Ok(LocalTextFile {
        path: file.to_string_lossy().into_owned(),
        content,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_files_inside_workspace_and_rejects_outside_paths() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let inside_file = workspace.path().join("src").join("main.rs");
        std::fs::create_dir_all(inside_file.parent().unwrap()).unwrap();
        std::fs::write(&inside_file, "fn main() {}\n").unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "secret\n").unwrap();

        assert_eq!(
            validated_file(
                inside_file.to_str().unwrap(),
                workspace.path().to_str().unwrap()
            )
            .unwrap(),
            inside_file.canonicalize().unwrap()
        );
        assert!(validated_file(
            outside_file.to_str().unwrap(),
            workspace.path().to_str().unwrap()
        )
        .unwrap_err()
        .contains("工作区外"));

        let content = read_text(
            inside_file.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(content.content, "fn main() {}\n");
    }
}
