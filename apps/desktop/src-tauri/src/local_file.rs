use std::path::{Path, PathBuf};

use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextFile {
    path: String,
    content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFilePreview {
    path: String,
    kind: &'static str,
    mime_type: &'static str,
    content: Option<String>,
    data_base64: Option<String>,
    size: u64,
}

fn preview_format(path: &Path) -> (&'static str, &'static str) {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "bmp" => ("image", "image/bmp"),
        "gif" => ("image", "image/gif"),
        "ico" => ("image", "image/x-icon"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "png" => ("image", "image/png"),
        "svg" => ("text", "image/svg+xml"),
        "webp" => ("image", "image/webp"),
        "mp3" => ("audio", "audio/mpeg"),
        "wav" => ("audio", "audio/wav"),
        "m4a" => ("audio", "audio/mp4"),
        "mov" => ("video", "video/quicktime"),
        "mp4" => ("video", "video/mp4"),
        "webm" => ("video", "video/webm"),
        "pdf" => ("pdf", "application/pdf"),
        "docx" => (
            "docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        "xlsx" | "xlsm" => (
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "pptx" => (
            "pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        "c" | "cc" | "cpp" | "cs" | "css" | "csv" | "diff" | "env" | "go" | "h"
        | "hpp" | "htm" | "html" | "ini" | "java" | "js" | "json" | "jsonl"
        | "jsx" | "kt" | "less" | "lock" | "log" | "md" | "mjs" | "patch" | "php"
        | "ps1" | "py" | "rb" | "rs" | "rst" | "sass" | "scss" | "sh" | "sql"
        | "svelte" | "swift" | "toml" | "ts" | "tsv" | "tsx" | "txt" | "vue"
        | "xml" | "yaml" | "yml" | "zsh" => ("text", "text/plain; charset=utf-8"),
        _ => ("unsupported", "application/octet-stream"),
    }
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

pub fn read_preview(path: &str, workspace_path: &str) -> Result<LocalFilePreview, String> {
    let file = validated_file(path, workspace_path)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取文件信息 {}: {error}", file.display()))?;
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "文件过大，内置预览上限为 64 MB（当前 {:.1} MB）",
            metadata.len() as f64 / 1024.0 / 1024.0
        ));
    }

    let (kind, mime_type) = preview_format(&file);
    let (content, data_base64) = if kind == "text" {
        let text = std::fs::read_to_string(&file)
            .map_err(|error| format!("无法读取 UTF-8 文本文件 {}: {error}", file.display()))?;
        (Some(text), None)
    } else if kind == "unsupported" {
        (None, None)
    } else {
        let bytes = std::fs::read(&file)
            .map_err(|error| format!("无法读取文件 {}: {error}", file.display()))?;
        (
            None,
            Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        )
    };

    Ok(LocalFilePreview {
        path: file.to_string_lossy().into_owned(),
        kind,
        mime_type,
        content,
        data_base64,
        size: metadata.len(),
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

        let preview = read_preview(
            inside_file.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(preview.kind, "text");
        assert_eq!(preview.content.as_deref(), Some("fn main() {}\n"));
    }
}
