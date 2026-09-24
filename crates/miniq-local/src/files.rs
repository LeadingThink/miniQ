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

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
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
        "aac" => ("audio", "audio/aac"),
        "flac" => ("audio", "audio/flac"),
        "m4a" => ("audio", "audio/mp4"),
        "mp3" => ("audio", "audio/mpeg"),
        "oga" | "ogg" => ("audio", "audio/ogg"),
        "opus" => ("audio", "audio/opus"),
        "wav" => ("audio", "audio/wav"),
        "avi" => ("video", "video/x-msvideo"),
        "m4v" => ("video", "video/x-m4v"),
        "mkv" => ("video", "video/x-matroska"),
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
    validated_file_with_authorization(path, workspace_path, workspace_paths, &[])
}

pub fn validated_file_with_authorization(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
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
    let authorized = authorized_files.iter().any(|authorized| {
        Path::new(authorized)
            .canonicalize()
            .is_ok_and(|authorized| authorized.is_file() && file == authorized)
    });
    if !file.starts_with(&workspace) && !attached && !authorized {
        return Err(format!("拒绝打开工作区外的文件: {}", file.display()));
    }
    Ok(file)
}

pub fn read_text(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
) -> Result<LocalTextFile, String> {
    read_text_with_authorization(path, workspace_path, workspace_paths, &[])
}

pub fn read_text_with_authorization(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<LocalTextFile, String> {
    let file =
        validated_file_with_authorization(path, workspace_path, workspace_paths, authorized_files)?;
    let content = std::fs::read_to_string(&file)
        .map_err(|error| format!("无法读取 UTF-8 文本文件 {}: {error}", file.display()))?;
    Ok(LocalTextFile {
        path: display_path(&file),
        content,
    })
}

pub fn read_preview(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
) -> Result<LocalFilePreview, String> {
    read_preview_with_authorization(path, workspace_path, workspace_paths, &[])
}

pub fn read_preview_with_authorization(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<LocalFilePreview, String> {
    let file =
        validated_file_with_authorization(path, workspace_path, workspace_paths, authorized_files)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取文件信息 {}: {error}", file.display()))?;
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "文件过大，内置预览上限为 64 MB（当前 {:.1} MB）",
            metadata.len() as f64 / 1024.0 / 1024.0
        ));
    }

    let (mut kind, mut mime_type) = preview_format(&file);
    let bytes = if matches!(kind, "text" | "markdown" | "unsupported") {
        None
    } else {
        Some(
            std::fs::read(&file)
                .map_err(|error| format!("无法读取文件 {}: {error}", file.display()))?,
        )
    };
    let office_text = matches!(kind, "docx" | "xlsx" | "pptx")
        && bytes
            .as_deref()
            .is_some_and(|bytes| !bytes.starts_with(b"PK") && std::str::from_utf8(bytes).is_ok());
    if office_text {
        kind = "text";
        mime_type = "text/plain; charset=utf-8";
    }
    let (content, data_base64) = if matches!(kind, "text" | "markdown") {
        let text = match bytes {
            Some(bytes) => String::from_utf8(bytes)
                .map_err(|error| format!("无法读取 UTF-8 文本文件 {}: {error}", file.display()))?,
            None => std::fs::read_to_string(&file)
                .map_err(|error| format!("无法读取 UTF-8 文本文件 {}: {error}", file.display()))?,
        };
        (Some(text), None)
    } else if kind == "unsupported" {
        (None, None)
    } else {
        (
            None,
            Some(base64::engine::general_purpose::STANDARD.encode(bytes.unwrap_or_default())),
        )
    };

    Ok(LocalFilePreview {
        path: display_path(&file),
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
    fn authorizes_only_the_explicitly_selected_file() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let selected = outside.path().join("selected.jsonl");
        let neighbor = outside.path().join("neighbor.jsonl");
        std::fs::write(&selected, "selected\n").unwrap();
        std::fs::write(&neighbor, "neighbor\n").unwrap();
        let authorized = vec![selected.display().to_string()];

        assert_eq!(
            read_text_with_authorization(
                selected.to_str().unwrap(),
                workspace.path().to_str().unwrap(),
                &[],
                &authorized,
            )
            .unwrap()
            .content,
            "selected\n"
        );
        let error = read_text_with_authorization(
            neighbor.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[],
            &authorized,
        )
        .err()
        .expect("neighboring file must remain unauthorized");
        assert!(error.contains("工作区外"));
    }

    #[test]
    fn previews_utf8_text_with_a_docx_extension_as_text() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("weather.docx");
        std::fs::write(&path, "上海今日天气情况\n").unwrap();

        let preview = read_preview(
            path.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[],
        )
        .unwrap();

        assert_eq!(preview.kind, "text");
        assert_eq!(preview.mime_type, "text/plain; charset=utf-8");
        assert_eq!(preview.content.as_deref(), Some("上海今日天气情况\n"));
        assert!(preview.data_base64.is_none());
    }

    #[test]
    fn preserves_zip_based_docx_preview() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("weather.docx");
        std::fs::write(&path, b"PK\x03\x04document").unwrap();

        let preview = read_preview(
            path.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[],
        )
        .unwrap();

        assert_eq!(preview.kind, "docx");
        assert!(preview.content.is_none());
        assert_eq!(preview.data_base64.as_deref(), Some("UEsDBGRvY3VtZW50"));
    }
}
