//! Screenshot files never travel through model text or streaming events.

use std::io::Write;
use std::path::{Path, PathBuf};

use miniq_models::{ChatImage, ImageDetail};
use serde_json::{json, Value};

use crate::ToolContext;

pub const MAX_OBSERVATION_BYTES: usize = 20 * 1024 * 1024;

pub fn observation_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "invalid observation id")?;
    Ok(root.join(format!("{id}.png")))
}

pub(crate) fn save(ctx: &ToolContext, png: &[u8]) -> Result<Value, String> {
    check_cancelled(ctx)?;
    if png.len() > MAX_OBSERVATION_BYTES {
        return Err("screenshot exceeds 20 MB; reduce the display resolution".into());
    }
    let (width, height) =
        image::ImageReader::with_format(std::io::Cursor::new(png), image::ImageFormat::Png)
            .into_dimensions()
            .map_err(|error| error.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(&ctx.observation_dir).map_err(|error| error.to_string())?;
    let path = observation_path(&ctx.observation_dir, &id)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(png))
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "id": id, "mimeType": "image/png", "width": width,
        "height": height, "bytes": png.len(),
    }))
}

pub(crate) fn images(ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
    output
        .pointer("/screenshot/id")
        .and_then(Value::as_str)
        .and_then(|id| observation_path(&ctx.observation_dir, id).ok())
        .map(|path| ChatImage {
            path: path.to_string_lossy().into_owned(),
            mime_type: "image/png".into(),
            detail: ImageDetail::High,
        })
        .into_iter()
        .collect()
}

pub(crate) fn check_cancelled(ctx: &ToolContext) -> Result<(), String> {
    if ctx.cancellation.is_cancelled() {
        Err("computer operation cancelled".into())
    } else {
        Ok(())
    }
}

pub(crate) fn pause(ctx: &ToolContext, milliseconds: u64) -> Result<(), String> {
    let until = std::time::Instant::now() + std::time::Duration::from_millis(milliseconds);
    loop {
        check_cancelled(ctx)?;
        let remaining = until.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(20)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_storage() {
        for id in ["../secret", "/tmp/a.png", "", "a.png"] {
            assert!(observation_path(Path::new("/observations"), id).is_err());
        }
    }

    #[test]
    fn screenshots_are_private_and_not_embedded_in_json() {
        let directory = tempfile::tempdir().unwrap();
        let ctx =
            ToolContext::new(directory.path().into()).with_observations(directory.path().into());
        let image = image::RgbaImage::new(10, 20);
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let output = json!({"screenshot": save(&ctx, png.get_ref()).unwrap()});
        assert_eq!(output["screenshot"]["width"], 10);
        assert_eq!(output["screenshot"]["height"], 20);
        let attachments = images(&ctx, &output);
        assert_eq!(attachments.len(), 1);
        assert_eq!(std::fs::read(&attachments[0].path).unwrap(), *png.get_ref());
        assert!(!output.to_string().contains("base64"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&attachments[0].path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn cancellation_stops_waits_and_saves() {
        let ctx = ToolContext::new(std::env::temp_dir());
        ctx.cancellation.cancel();
        assert!(pause(&ctx, 5000).is_err());
        assert!(save(&ctx, &[]).is_err());
    }
}
