pub(crate) use miniq_local::files::validated_file;
pub use miniq_local::files::LocalTargetKind;
#[cfg(test)]
use miniq_local::files::{preview_format, read_preview, read_text, validated_target};
use miniq_local::files::{
    read_preview_with_authorization, read_text_with_authorization,
    validated_target_with_authorization,
};
pub use miniq_local::files::{LocalFilePreview, LocalTextFile};
use std::path::Path;

use base64::Engine;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// Upper bound for one pasted or dropped image. Mirrors `imageLimits.ts`.
const MAX_PASTED_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// Upper bound for one pasted file. Mirrors `MAX_PASTED_FILE_BYTES` in `localFiles.ts`.
const MAX_PASTED_FILE_BYTES: usize = 200 * 1024 * 1024;
/// Longest stem kept for a pasted file so the stored path stays short.
const MAX_PASTED_FILE_STEM_CHARS: usize = 60;

fn too_large() -> String {
    format!("图片不能超过 {} MB", MAX_PASTED_IMAGE_BYTES / (1024 * 1024))
}

fn pasted_file_too_large() -> String {
    format!("文件不能超过 {} MB", MAX_PASTED_FILE_BYTES / (1024 * 1024))
}

/// Pasted and dragged files live beside the user's data, never in the cache:
/// sent messages keep referring to their absolute paths, so a cache cleanup
/// must not be able to break the conversation.
fn attachments_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法访问应用数据目录: {error}"))?
        .join("attachments");
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建附件目录: {error}"))?;
    Ok(directory)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImagePreview {
    mime_type: &'static str,
    data_base64: String,
}

/// Extension for a clipboard MIME type, used when the pasted file carries no name.
fn extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

/// A pasted file's display name: base name only, safe on Windows, with the
/// extension preserved so the daemon can classify the attachment.
fn pasted_file_name(name: &str, mime_type: &str) -> String {
    let base = name.rsplit(['\\', '/']).next().unwrap_or_default();
    let base: String = base
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| match character {
            ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let path = Path::new(base.trim().trim_matches('.'));
    let mut stem: String = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .chars()
        .take(MAX_PASTED_FILE_STEM_CHARS)
        .collect();
    if stem.is_empty() {
        stem = "pasted-file".to_string();
    }
    match path
        .extension()
        .and_then(|value| value.to_str())
        .or_else(|| extension_for_mime(mime_type))
    {
        Some(extension) => format!("{stem}.{extension}"),
        None => stem,
    }
}

fn image_format(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Stores a pasted clipboard file in the app's attachment directory and returns its path.
pub fn save_pasted_file(
    app: &AppHandle,
    name: &str,
    mime_type: &str,
    data_base64: &str,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("无法解码剪贴板文件: {error}"))?;
    if bytes.is_empty() {
        return Err("剪贴板文件内容为空".to_string());
    }
    if bytes.len() > MAX_PASTED_FILE_BYTES {
        return Err(pasted_file_too_large());
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("无法生成目录名: {error}"))?
        .as_nanos();
    // One directory per paste keeps the original name in the attachment chip.
    let directory = attachments_dir(app)?.join(format!("{timestamp}-{}", std::process::id()));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建剪贴板文件目录: {error}"))?;
    let path = directory.join(pasted_file_name(name, mime_type));
    std::fs::write(&path, bytes).map_err(|error| format!("无法保存剪贴板文件: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Stores image bytes read from a macOS drag pasteboard.
// Only the macOS drag pasteboard reader saves raw image bytes; other platforms
// receive image files and their paths instead.
#[allow(dead_code)]
pub fn save_image(app: &AppHandle, extension: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err(too_large());
    }

    let directory = attachments_dir(app)?.join("dragged-images");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建拖入图片目录: {error}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("无法生成图片文件名: {error}"))?
        .as_nanos();
    let path = directory.join(format!(
        "dragged-{}-{}.{}",
        timestamp,
        std::process::id(),
        extension
    ));
    std::fs::write(&path, bytes).map_err(|error| format!("无法保存拖入图片: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn read_image_preview(path: &str) -> Result<LocalImagePreview, String> {
    let file =
        dunce::canonicalize(path).map_err(|error| format!("无法访问图片 {path}: {error}"))?;
    let mime_type = image_format(&file).ok_or_else(|| "附件不是支持的图片格式".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取图片信息 {}: {error}", file.display()))?;
    if !metadata.is_file() {
        return Err(format!("附件不是文件: {}", file.display()));
    }
    if metadata.len() > MAX_PASTED_IMAGE_BYTES as u64 {
        return Err(too_large());
    }
    let bytes = std::fs::read(&file)
        .map_err(|error| format!("无法读取图片 {}: {error}", file.display()))?;
    Ok(LocalImagePreview {
        mime_type,
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Hands the target to the OS: a file opens in its default application and a
/// folder opens in the system file manager.
pub fn open(
    app: &AppHandle,
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<(), String> {
    let target = validated_target_with_authorization(
        path,
        workspace_path,
        workspace_paths,
        authorized_files,
    )?;
    app.opener()
        .open_path(target.into_path().to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn reveal(
    app: &AppHandle,
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<(), String> {
    let target = validated_target_with_authorization(
        path,
        workspace_path,
        workspace_paths,
        authorized_files,
    )?;
    app.opener()
        .reveal_item_in_dir(target.into_path())
        .map_err(|error| error.to_string())
}

/// Reports what a path is so the UI can pick preview or the system opener.
pub fn target_kind(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<LocalTargetKind, String> {
    Ok(validated_target_with_authorization(
        path,
        workspace_path,
        workspace_paths,
        authorized_files,
    )?
    .kind())
}

pub fn read_text_authorized(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<LocalTextFile, String> {
    read_text_with_authorization(path, workspace_path, workspace_paths, authorized_files)
}

pub fn read_preview_authorized(
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<LocalFilePreview, String> {
    read_preview_with_authorization(path, workspace_path, workspace_paths, authorized_files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_attached_roots_and_preserves_relative_cwd() {
        let primary = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let file = extra.path().join("report.md");
        std::fs::write(&file, "# Attached report\n").unwrap();
        let roots = vec![extra.path().display().to_string()];
        let preview = read_preview(
            file.to_str().unwrap(),
            primary.path().to_str().unwrap(),
            &roots,
        )
        .unwrap();
        assert_eq!(preview.kind, "markdown");
        assert_eq!(preview.content.as_deref(), Some("# Attached report\n"));
        assert!(read_preview(
            file.to_str().unwrap(),
            primary.path().to_str().unwrap(),
            &[]
        )
        .is_err());
        std::fs::write(primary.path().join("local.txt"), "cwd").unwrap();
        assert_eq!(
            read_text("local.txt", primary.path().to_str().unwrap(), &roots)
                .unwrap()
                .content,
            "cwd"
        );
    }

    #[test]
    fn keeps_the_pasted_file_name_and_extension() {
        assert_eq!(pasted_file_name("报告.pdf", "application/pdf"), "报告.pdf");
        assert_eq!(pasted_file_name("/tmp/quarterly.PDF", ""), "quarterly.PDF");
        assert_eq!(
            pasted_file_name(r"C:\Users\me\My Files\plan.docx", ""),
            "plan.docx"
        );
    }

    #[test]
    fn repairs_unsafe_or_missing_pasted_file_names() {
        assert_eq!(pasted_file_name("", "application/pdf"), "pasted-file.pdf");
        assert_eq!(pasted_file_name("...", "image/png"), "pasted-file.png");
        assert_eq!(pasted_file_name("a:b*c?.txt", ""), "a_b_c_.txt");
        assert_eq!(pasted_file_name("shot", "image/png"), "shot.png");
        assert_eq!(
            pasted_file_name(&format!("{}.md", "长".repeat(120)), ""),
            format!("{}.md", "长".repeat(MAX_PASTED_FILE_STEM_CHARS))
        );
    }

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
                workspace.path().to_str().unwrap(),
                &[]
            )
            .unwrap(),
            dunce::canonicalize(&inside_file).unwrap()
        );
        assert!(validated_file(
            outside_file.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[]
        )
        .unwrap_err()
        .contains("工作区外"));

        let content = read_text(
            inside_file.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[],
        )
        .unwrap();
        assert_eq!(content.content, "fn main() {}\n");

        let preview = read_preview(
            inside_file.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[],
        )
        .unwrap();
        assert_eq!(preview.kind, "text");
        assert_eq!(preview.content.as_deref(), Some("fn main() {}\n"));
    }

    #[test]
    fn hands_folders_to_the_system_opener_but_never_previews_them() {
        let workspace = tempfile::tempdir().unwrap();
        let folder = workspace.path().join("outputs").join("配图");
        std::fs::create_dir_all(&folder).unwrap();
        let workspace_path = workspace.path().to_str().unwrap();
        let folder_path = folder.to_str().unwrap();

        assert_eq!(
            target_kind(folder_path, workspace_path, &[], &[]).unwrap(),
            LocalTargetKind::Directory
        );
        assert_eq!(
            validated_target(folder_path, workspace_path, &[])
                .unwrap()
                .kind(),
            LocalTargetKind::Directory
        );
        assert!(validated_file(folder_path, workspace_path, &[])
            .unwrap_err()
            .contains("目标不是文件"));
    }

    #[test]
    fn identifies_markdown_and_named_text_files() {
        assert_eq!(
            preview_format(Path::new("notes.MARKDOWN")),
            ("markdown", "text/markdown; charset=utf-8")
        );
        assert_eq!(
            preview_format(Path::new("README")),
            ("markdown", "text/markdown; charset=utf-8")
        );
        assert_eq!(preview_format(Path::new(".env.local")).0, "text");
        assert_eq!(preview_format(Path::new("Dockerfile")).0, "text");
        assert_eq!(preview_format(Path::new("script.cjs")).0, "text");
        assert_eq!(preview_format(Path::new("types.pyi")).0, "text");
    }

    #[test]
    fn reads_markdown_as_text_for_the_rendered_preview() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("README.md");
        std::fs::write(&path, "# Preview\n").unwrap();

        let preview = read_preview(
            path.to_str().unwrap(),
            workspace.path().to_str().unwrap(),
            &[],
        )
        .unwrap();

        assert_eq!(preview.kind, "markdown");
        assert_eq!(preview.mime_type, "text/markdown; charset=utf-8");
        assert_eq!(preview.content.as_deref(), Some("# Preview\n"));
        assert!(preview.data_base64.is_none());
    }
}
