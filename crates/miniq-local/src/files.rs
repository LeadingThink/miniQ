//! Workspace-scoped file previews shared by the desktop shell and daemon.
use base64::Engine;
use std::path::{Path, PathBuf};

pub const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextFile {
    pub path: String,
    pub content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFilePreview {
    pub path: String,
    pub kind: &'static str,
    pub mime_type: &'static str,
    pub content: Option<String>,
    pub data_base64: Option<String>,
    pub size: u64,
}

pub fn preview_format(path: &Path) -> (&'static str, &'static str) {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(name.as_str(), "readme" | "changelog")
        || matches!(extension.as_str(), "md" | "markdown")
    {
        return ("markdown", "text/markdown; charset=utf-8");
    }
    if matches!(
        name.as_str(),
        ".dockerignore"
            | ".editorconfig"
            | ".gitattributes"
            | ".gitignore"
            | ".gitmodules"
            | ".npmrc"
            | ".prettierignore"
            | ".prettierrc"
            | "dockerfile"
            | "license"
            | "makefile"
    ) || name == ".env"
        || name.starts_with(".env.")
    {
        return ("text", "text/plain; charset=utf-8");
    }
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
        "bash" | "bat" | "c" | "cc" | "cjs" | "conf" | "cpp" | "cs" | "css" | "csv" | "diff"
        | "env" | "fish" | "go" | "h" | "hpp" | "htm" | "html" | "ini" | "java" | "js" | "json"
        | "jsonl" | "jsx" | "kt" | "kts" | "less" | "lock" | "log" | "mjs" | "patch" | "php"
        | "ps1" | "py" | "pyi" | "rb" | "rs" | "rst" | "sass" | "scss" | "sh" | "sql"
        | "svelte" | "swift" | "toml" | "ts" | "tsv" | "tsx" | "txt" | "vue" | "xml" | "yaml"
        | "yml" | "zsh" => ("text", "text/plain; charset=utf-8"),
        _ => ("unsupported", "application/octet-stream"),
    }
}

pub fn validated_file(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
) -> Result<PathBuf, String> {
    let workspace = Path::new(workspace_path)
        .canonicalize()
        .map_err(|error| format!("无法访问工作区 {workspace_path}: {error}"))?;
    if !workspace.is_dir() {
        return Err(format!("工作区不是目录: {}", workspace.display()));
    }

    let file = workspace
        .join(path)
        .canonicalize()
        .map_err(|error| format!("无法访问文件 {path}: {error}"))?;
    if !file.is_file() {
        return Err(format!("目标不是文件: {}", file.display()));
    }
    let attached = workspace_paths.iter().any(|root| {
        Path::new(root)
            .canonicalize()
            .is_ok_and(|root| root.is_dir() && file.starts_with(root))
    });
    if !file.starts_with(&workspace) && !attached {
        return Err(format!("拒绝打开工作区外的文件: {}", file.display()));
    }
    Ok(file)
}

pub fn read_text(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
) -> Result<LocalTextFile, String> {
    let file = validated_file(path, workspace_path, workspace_paths)?;
    let content = std::fs::read_to_string(&file)
        .map_err(|error| format!("无法读取 UTF-8 文本文件 {}: {error}", file.display()))?;
    Ok(LocalTextFile {
        path: file.to_string_lossy().into_owned(),
        content,
    })
}

pub fn read_preview(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
) -> Result<LocalFilePreview, String> {
    let file = validated_file(path, workspace_path, workspace_paths)?;
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
    let (content, data_base64) = if matches!(kind, "text" | "markdown") {
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
