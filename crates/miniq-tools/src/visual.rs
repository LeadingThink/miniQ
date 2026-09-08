//! Local visual evidence uses the same private observation transport as screenshots.

use std::io::{Cursor, Read};
use std::path::Path;

use async_trait::async_trait;
use image::{AnimationDecoder, ImageDecoder, ImageFormat};
use miniq_models::ChatImage;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::file::path_risk;
use crate::observation::{self, MAX_OBSERVATION_BYTES};
use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub struct ViewImageTool;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ImageInput {
    path: String,
    #[serde(default)]
    detail: Detail,
}

#[derive(Default, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Detail {
    #[default]
    High,
    Original,
}

#[async_trait]
impl Tool for ViewImageTool {
    fn name(&self) -> &str {
        "view_image"
    }
    fn description(&self) -> &str {
        "Inspect a local PNG, JPEG, WebP or static GIF with the current model's vision. Returns actual image content, not OCR. Use after extracting image files from an archive. Original pixels are preserved; animated images require explicit frame extraction."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(ImageInput)).expect("image schema")
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(ctx, input, RiskLevel::Low, "read-only local image access")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: ImageInput = parse_input(input)?;
        let path = ctx
            .resolve_read_path(&input.path)
            .map_err(|error| ToolError::SandboxDenied(error.to_string()))?;
        let context = ctx.clone();
        let screenshot = tokio::task::spawn_blocking(move || snapshot(&context, &path))
            .await
            .map_err(failed)??;
        Ok(json!({"path": input.path, "screenshot": screenshot,
            "detail": match input.detail { Detail::High => "high", Detail::Original => "original" },
            "source": "local_image", "resized": false}))
    }
    fn output_images(&self, ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
        observation::images(ctx, output)
    }
}

pub(crate) fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::ExecutionFailed(error.to_string())
}

pub(crate) fn snapshot(ctx: &ToolContext, path: &Path) -> Result<Value, ToolError> {
    observation::check_cancelled(ctx).map_err(failed)?;
    let file = std::fs::File::open(path).map_err(failed)?;
    if !file.metadata().map_err(failed)?.is_file() {
        return Err(ToolError::InvalidInput(
            "image path must be a regular file".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_OBSERVATION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(failed)?;
    if bytes.len() > MAX_OBSERVATION_BYTES {
        return Err(ToolError::InvalidInput(
            "image exceeds 20 MB; select an explicit crop or smaller file".into(),
        ));
    }
    let format = image::guess_format(&bytes).map_err(failed)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
    ) {
        return Err(ToolError::InvalidInput(
            "supported image formats: PNG, JPEG, WebP, static GIF".into(),
        ));
    }
    reject_animation(&bytes, format)?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decode_limits());
    let mut decoder = reader.into_decoder().map_err(failed)?;
    let orientation = image::ImageDecoder::orientation(&mut decoder).map_err(failed)?;
    let mut pixels = image::DynamicImage::from_decoder(decoder).map_err(failed)?;
    pixels.apply_orientation(orientation);
    let mut png = Cursor::new(Vec::new());
    pixels
        .write_to(&mut png, ImageFormat::Png)
        .map_err(failed)?;
    observation::save(ctx, png.get_ref()).map_err(failed)
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits
}

fn reject_animation(bytes: &[u8], format: ImageFormat) -> Result<(), ToolError> {
    let animated = match format {
        ImageFormat::Gif => {
            let mut decoder =
                image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(failed)?;
            decoder.set_limits(decode_limits()).map_err(failed)?;
            decoder
                .into_frames()
                .take(2)
                .collect::<Result<Vec<_>, _>>()
                .map_err(failed)?
                .len()
                > 1
        }
        ImageFormat::Png => image::codecs::png::PngDecoder::new(Cursor::new(bytes))
            .map_err(failed)?
            .is_apng()
            .map_err(failed)?,
        ImageFormat::WebP => image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .map_err(failed)?
            .has_animation(),
        _ => false,
    };
    if animated {
        return Err(ToolError::InvalidInput("animated image: extract and inspect explicit frames; no frames were silently discarded".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn real_pixels_are_private_snapshots_not_text_or_mutable_source_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("misnamed.txt");
        image::RgbImage::from_pixel(12, 18, image::Rgb([25, 70, 120]))
            .save_with_format(&path, ImageFormat::Jpeg)
            .unwrap();
        let ctx =
            ToolContext::new(dir.path().into()).with_observations(dir.path().join("observations"));
        let out = ViewImageTool
            .execute(&ctx, json!({"path":"misnamed.txt", "detail":"original"}))
            .await
            .unwrap();
        assert_eq!(out["screenshot"]["width"], 12);
        assert!(!out.to_string().contains("base64"));
        let images = ViewImageTool.output_images(&ctx, &out);
        assert_eq!(images.len(), 1);
        std::fs::write(&path, "changed").unwrap();
        assert_eq!(image::open(&images[0].path).unwrap().height(), 18);
        assert!(ViewImageTool
            .execute(&ctx, json!({"path":"misnamed.txt"}))
            .await
            .is_err());
        assert!(ViewImageTool
            .execute(&ctx, json!({"path":"../secret.png"}))
            .await
            .is_err());
        assert!(ViewImageTool
            .execute(&ctx, json!({"path":"misnamed.txt", "detail":"low"}))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn explicit_attachment_grants_no_writes_or_sibling_access() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().join("image.png");
        image::RgbImage::new(4, 6).save(&path).unwrap();
        let sibling = outside.path().join("private.png");
        image::RgbImage::new(4, 6).save(&sibling).unwrap();
        let ctx = ToolContext::new(workspace.path().into())
            .with_readable_files(vec![path.canonicalize().unwrap()])
            .with_observations(workspace.path().join("observations"));
        assert!(ViewImageTool
            .execute(&ctx, json!({"path":path}))
            .await
            .is_ok());
        assert!(ViewImageTool
            .execute(&ctx, json!({"path":sibling}))
            .await
            .is_err());
        assert!(ctx.resolve_path(path.to_str().unwrap()).is_err());
        assert_eq!(
            crate::FileWriteTool
                .evaluate_risk(&ctx, &json!({"path":path}))
                .level,
            RiskLevel::Blocked
        );
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&sibling, &path).unwrap();
            assert!(ViewImageTool
                .execute(&ctx, json!({"path":path}))
                .await
                .is_err());
        }
    }

    #[test]
    fn animated_images_are_not_silently_flattened() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            for _ in 0..2 {
                encoder
                    .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
                    .unwrap();
            }
        }
        assert!(reject_animation(&bytes, ImageFormat::Gif).is_err());
    }

    #[test]
    fn animation_detection_limits_the_logical_canvas_allocation() {
        let mut bytes = Vec::new();
        image::codecs::gif::GifEncoder::new(&mut bytes)
            .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
            .unwrap();
        // The tiny frame still belongs to an enormous logical GIF canvas.
        bytes[6..10].copy_from_slice(&[255, 255, 255, 255]);
        let error = reject_animation(&bytes, ImageFormat::Gif).unwrap_err();
        assert!(error.to_string().contains("limit"), "{error}");
    }
}
