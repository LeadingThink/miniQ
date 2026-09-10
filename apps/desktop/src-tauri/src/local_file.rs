#[cfg(test)]
use miniq_local::files::preview_format;
pub(crate) use miniq_local::files::validated_file;
pub use miniq_local::files::{read_preview, read_text, LocalFilePreview, LocalTextFile};
use std::path::Path;

use base64::Engine;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const MAX_PASTED_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImagePreview {
    mime_type: &'static str,
    data_base64: String,
}

fn pasted_image_format(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
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

pub fn save_pasted_image(
    app: &AppHandle,
    mime_type: &str,
    data_base64: &str,
) -> Result<String, String> {
    let extension = pasted_image_format(mime_type)
        .ok_or_else(|| "仅支持 PNG、JPEG、WebP 或 GIF 图片".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("无法解码剪贴板图片: {error}"))?;
    if bytes.is_empty() {
        return Err("剪贴板图片内容为空".to_string());
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err("图片不能超过 20 MB".to_string());
    }

    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法访问应用缓存目录: {error}"))?
        .join("pasted-images");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建剪贴板图片目录: {error}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("无法生成图片文件名: {error}"))?
        .as_nanos();
    let path = directory.join(format!(
        "pasted-{}-{}.{}",
        timestamp,
        std::process::id(),
        extension
    ));
    std::fs::write(&path, bytes).map_err(|error| format!("无法保存剪贴板图片: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn read_image_preview(path: &str) -> Result<LocalImagePreview, String> {
    let file = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("无法访问图片 {path}: {error}"))?;
    let mime_type = image_format(&file).ok_or_else(|| "附件不是支持的图片格式".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取图片信息 {}: {error}", file.display()))?;
    if !metadata.is_file() {
        return Err(format!("附件不是文件: {}", file.display()));
    }
    if metadata.len() > MAX_PASTED_IMAGE_BYTES as u64 {
        return Err("图片不能超过 20 MB".to_string());
    }
    let bytes = std::fs::read(&file)
        .map_err(|error| format!("无法读取图片 {}: {error}", file.display()))?;
    Ok(LocalImagePreview {
        mime_type,
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

pub fn open(
    app: &AppHandle,
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
) -> Result<(), String> {
    let file = validated_file(path, workspace_path, workspace_paths)?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn reveal(
    app: &AppHandle,
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
) -> Result<(), String> {
    let file = validated_file(path, workspace_path, workspace_paths)?;
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|error| error.to_string())
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
    fn accepts_image_formats_supported_by_the_daemon() {
        assert_eq!(pasted_image_format("image/png"), Some("png"));
        assert_eq!(pasted_image_format("image/jpeg"), Some("jpg"));
        assert_eq!(pasted_image_format("image/webp"), Some("webp"));
        assert_eq!(pasted_image_format("image/gif"), Some("gif"));
    }

    #[test]
    fn rejects_unsupported_image_formats() {
        assert_eq!(pasted_image_format("image/bmp"), None);
        assert_eq!(pasted_image_format("image/svg+xml"), None);
        assert_eq!(pasted_image_format("IMAGE/PNG"), None);
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
            inside_file.canonicalize().unwrap()
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
