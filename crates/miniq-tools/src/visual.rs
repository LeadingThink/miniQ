//! Local visual evidence uses the same private observation transport as screenshots.

use std::io::Cursor;
use std::path::Path;

use async_trait::async_trait;
use image::ImageFormat;
use miniq_models::{load_static_image, ChatImage, ImageDetail};
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::file::path_risk;
use crate::observation;
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
        "Inspect a local PNG, JPEG, WebP or static GIF with the current model's vision. Returns actual image content, not OCR. Use after extracting image files from an archive. Default detail=high sends an aspect-preserving preview within 2048×2048 and 2.5 million pixels. Use detail=original to inspect exact original resolution, such as small text. Original pixels remain available; animated images require explicit frame extraction."
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
        let detail = match input.detail {
            Detail::High => ImageDetail::Preview,
            Detail::Original => ImageDetail::High,
        };
        let dimensions = screenshot["width"]
            .as_u64()
            .zip(screenshot["height"].as_u64())
            .ok_or_else(|| failed("snapshot dimensions unavailable"))?;
        let target = detail.target_dimensions(dimensions.0 as u32, dimensions.1 as u32);
        Ok(json!({"path": input.path, "screenshot": screenshot,
        "detail": match input.detail { Detail::High => "high", Detail::Original => "original" },
        "source": "local_image",
        "originalDimensions": {"width": dimensions.0, "height": dimensions.1},
        "modelImage": {
            "preparation": "on_send",
            "policy": if detail == ImageDetail::Preview { "bounded_preview" } else { "original_pixels" },
            "detail": detail.wire_detail(),
            "targetWidth": target.0, "targetHeight": target.1,
            "originalAvailable": true,
        }}))
    }
    fn output_images(&self, ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
        let detail = if output["detail"] == "original" {
            ImageDetail::High
        } else {
            ImageDetail::Preview
        };
        observation::images(ctx, output)
            .into_iter()
            .map(|mut image| {
                image.detail = detail;
                image
            })
            .collect()
    }
}

pub(crate) fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::ExecutionFailed(error.to_string())
}

pub(crate) fn snapshot(ctx: &ToolContext, path: &Path) -> Result<Value, ToolError> {
    observation::check_cancelled(ctx).map_err(failed)?;
    let pixels = load_static_image(path).map_err(failed)?;
    let mut png = Cursor::new(Vec::new());
    pixels
        .write_to(&mut png, ImageFormat::Png)
        .map_err(failed)?;
    observation::save(ctx, png.get_ref()).map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_models::decode_static_image;

    #[tokio::test]
    async fn default_preview_reports_source_and_target_without_resizing_the_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.png");
        image::RgbImage::new(3200, 2400).save(&path).unwrap();
        let ctx =
            ToolContext::new(dir.path().into()).with_observations(dir.path().join("observations"));
        let output = ViewImageTool
            .execute(&ctx, json!({"path":"large.png"}))
            .await
            .unwrap();
        let preview = ViewImageTool.output_images(&ctx, &output);
        assert_eq!(preview[0].detail, ImageDetail::Preview);
        assert_eq!(
            output["originalDimensions"],
            json!({"width":3200, "height":2400})
        );
        assert_eq!(output["modelImage"]["preparation"], "on_send");
        assert_eq!(output["modelImage"]["policy"], "bounded_preview");
        let target = ImageDetail::Preview.target_dimensions(3200, 2400);
        assert_eq!(output["modelImage"]["targetWidth"], target.0);
        assert_eq!(output["modelImage"]["targetHeight"], target.1);
        let snapshot = image::open(&preview[0].path).unwrap();
        assert_eq!((snapshot.width(), snapshot.height()), (3200, 2400));

        let output = ViewImageTool
            .execute(&ctx, json!({"path":"large.png", "detail":"original"}))
            .await
            .unwrap();
        assert_eq!(
            ViewImageTool.output_images(&ctx, &output)[0].detail,
            ImageDetail::High
        );
        assert_eq!(output["modelImage"]["policy"], "original_pixels");
        assert_eq!(output["modelImage"]["targetWidth"], 3200);
        assert_eq!(output["modelImage"]["targetHeight"], 2400);
        // Computer/browser observation transport keeps full-resolution coordinates.
        assert_eq!(
            observation::images(&ctx, &output)[0].detail,
            ImageDetail::High
        );
    }

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
        assert!(decode_static_image(&bytes).is_err());
    }

    #[test]
    fn animation_detection_limits_the_logical_canvas_allocation() {
        let mut bytes = Vec::new();
        image::codecs::gif::GifEncoder::new(&mut bytes)
            .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
            .unwrap();
        // The tiny frame still belongs to an enormous logical GIF canvas.
        bytes[6..10].copy_from_slice(&[255, 255, 255, 255]);
        let error = decode_static_image(&bytes).unwrap_err();
        assert!(error.to_string().contains("limit"), "{error}");
    }
}
