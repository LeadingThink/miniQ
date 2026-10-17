//! Workspace-scoped file previews shared by the desktop shell and daemon.
use base64::Engine;
use std::path::{Path, PathBuf};

/// Largest file the desktop side panel previews (PDF, images, Office, tables).
/// The file is read into memory and base64-encoded, so peak memory is several
/// times this size.
pub const MAX_PREVIEW_BYTES: u64 = 128 * 1024 * 1024;
/// Text and Markdown are rendered in one pass, so they get a lower limit.
pub const MAX_TEXT_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;

/// Preview size limit for one preview kind.
pub fn preview_limit(kind: &str) -> u64 {
    if matches!(kind, "text" | "markdown") {
        MAX_TEXT_PREVIEW_BYTES
    } else {
        MAX_PREVIEW_BYTES
    }
}

fn megabytes(bytes: u64) -> u64 {
    bytes / 1024 / 1024
}

/// User-facing text for a file that is over its preview limit.
pub fn preview_limit_message(kind: &str, size: u64) -> String {
    format!(
        "文件过大，内置预览上限为 {} MB（当前 {:.1} MB），请用外部程序打开",
        megabytes(preview_limit(kind)),
        size as f64 / 1024.0 / 1024.0
    )
}

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
        "doc" | "xls" | "ppt" | "wps" | "et" | "dps" => {
            ("officeLegacy", "application/vnd.miniq.office-legacy")
        }
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
    let workspace = dunce::canonicalize(workspace_path)
        .map_err(|error| format!("无法访问工作区 {workspace_path}: {error}"))?;
    if !workspace.is_dir() {
        return Err(format!("工作区不是目录: {}", workspace.display()));
    }

    let file = dunce::canonicalize(workspace.join(path))
        .map_err(|error| format!("无法访问文件 {path}: {error}"))?;
    if !file.is_file() {
        return Err(format!("目标不是文件: {}", file.display()));
    }
    let attached = workspace_paths.iter().any(|root| {
        dunce::canonicalize(root).is_ok_and(|root| root.is_dir() && file.starts_with(root))
    });
    let authorized = authorized_files.iter().any(|authorized| {
        dunce::canonicalize(authorized)
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
        path: file.to_string_lossy().into_owned(),
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
    let (mut kind, mut mime_type) = preview_format(&file);
    if metadata.len() > preview_limit(kind) {
        return Err(preview_limit_message(kind, metadata.len()));
    }

    let bytes = if matches!(kind, "text" | "markdown" | "officeLegacy" | "unsupported") {
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
    } else if matches!(kind, "officeLegacy" | "unsupported") {
        (None, None)
    } else {
        (
            None,
            Some(base64::engine::general_purpose::STANDARD.encode(bytes.unwrap_or_default())),
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
    fn preview_limits_depend_on_the_kind() {
        assert_eq!(preview_limit("pdf"), 128 * 1024 * 1024);
        assert_eq!(preview_limit("image"), 128 * 1024 * 1024);
        assert_eq!(preview_limit("text"), 16 * 1024 * 1024);
        assert_eq!(preview_limit("markdown"), 16 * 1024 * 1024);
        let message = preview_limit_message("pdf", 200 * 1024 * 1024);
        assert!(message.contains("128 MB") && message.contains("200.0 MB"));
        assert!(preview_limit_message("text", 20 * 1024 * 1024).contains("16 MB"));
    }

    #[test]
    fn rejects_files_over_their_kind_limit_without_reading_them() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_str().unwrap();
        // Sparse files: set_len allocates no real disk space and nothing is read.
        let big_pdf = workspace.path().join("big.pdf");
        std::fs::File::create(&big_pdf)
            .unwrap()
            .set_len(MAX_PREVIEW_BYTES + 1)
            .unwrap();
        let error = read_preview(big_pdf.to_str().unwrap(), root, &[])
            .err()
            .unwrap();
        assert!(error.contains("128 MB"), "{error}");

        let big_text = workspace.path().join("big.txt");
        std::fs::File::create(&big_text)
            .unwrap()
            .set_len(MAX_TEXT_PREVIEW_BYTES + 1)
            .unwrap();
        let error = read_preview(big_text.to_str().unwrap(), root, &[])
            .err()
            .unwrap();
        assert!(error.contains("16 MB"), "{error}");
    }

    #[test]
    fn a_file_between_the_old_and_new_limit_still_previews() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("mid.pdf");
        // 70 MB: over the old 64 MB limit, under the new 128 MB limit.
        std::fs::write(&path, vec![0u8; 70 * 1024 * 1024]).unwrap();
        let preview = read_preview(
            path.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[],
        )
        .unwrap();
        assert_eq!(preview.kind, "pdf");
        assert!(preview.data_base64.is_some());
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

    #[test]
    fn routes_legacy_office_and_wps_formats_to_native_conversion() {
        for name in [
            "report.doc",
            "ledger.xls",
            "briefing.ppt",
            "draft.wps",
            "accounts.et",
            "slides.dps",
        ] {
            assert_eq!(
                preview_format(Path::new(name)),
                ("officeLegacy", "application/vnd.miniq.office-legacy"),
                "unexpected preview format for {name}",
            );
        }
    }
}
