//! Native, provider-agnostic media capabilities backed by the configured
//! OneAPI-compatible endpoint. Tools deliberately keep media out of the main
//! model picker: the chat model decides when a capability is appropriate.

use async_trait::async_trait;
use base64::Engine;
use miniq_models::{ChatImage, ModelFirstRequest};
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::file::path_risk;
use crate::router::{parse_input, MediaConfig, Tool, ToolContext, ToolError};

mod audio;
pub use audio::{SynthesizeSpeechTool, TranscribeAudioTool};
mod image;
mod video;
mod video_result;
pub use video_result::GetVideoGenerationTool;
mod music;
pub use image::GenerateImageTool;
pub use music::GenerateMusicTool;
pub use video::GenerateVideoTool;

mod inputs;
mod schema;
use inputs::*;
pub use schema::decorate_media_specs;
use schema::*;
pub(crate) use schema::{grok_video_schema, h3_video_schema, video_schema};

async fn selected_model(
    media: &MediaConfig,
    kind: &str,
    requested: Option<String>,
    preferred: &str,
) -> Result<String, ToolError> {
    if requested
        .as_ref()
        .is_some_and(|model| model.trim().is_empty() || model.chars().any(char::is_control))
    {
        return Err(ToolError::InvalidInput(
            "model must be a nonempty model ID".into(),
        ));
    }
    if let Some(registry) = &media.capabilities {
        // The daemon also refreshes daily while idle. Refresh on use covers
        // a channel configured since the last background check.
        let _ = registry.refresh_due(media).await;
        if let Some(snapshot) = registry.snapshot(&media.base_url) {
            return snapshot
                .select_model(kind, preferred, requested.as_deref())
                .map_err(ToolError::InvalidInput);
        }
    }
    let model = requested
        .unwrap_or_else(|| preferred.to_owned())
        .trim()
        .to_owned();
    if model.trim().is_empty() {
        return Err(ToolError::InvalidInput("model must not be empty".into()));
    }
    Ok(model)
}

fn nonempty_string(value: Option<String>, field: &str) -> Result<Option<String>, ToolError> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(ToolError::InvalidInput(format!(
            "{field} must not be empty"
        )));
    }
    Ok(Some(value))
}

fn image_request_body(media: &MediaConfig, model: String, input: ImageInput) -> Value {
    if codex_image_route(media, &model) {
        return json!({"model": model, "prompt": prompt_with_image_options(input.prompt, input.size, input.quality)});
    }
    let mut body = json!({"model": model, "prompt": input.prompt});
    if let Some(value) = input.size {
        body["size"] = value.into();
    }
    if let Some(value) = input.quality {
        body["quality"] = value.into();
    }
    body
}

fn prompt_with_image_options(
    prompt: String,
    size: Option<String>,
    quality: Option<String>,
) -> String {
    let mut guidance = Vec::new();
    if let Some(size) = size.filter(|value| !value.trim().is_empty()) {
        guidance.push(format!("构图和画幅要求：{size}。"));
    }
    if let Some(quality) = quality.filter(|value| !value.trim().is_empty()) {
        guidance.push(format!("视觉质量要求：{quality}细节。"));
    }
    if guidance.is_empty() {
        prompt
    } else {
        format!("{prompt}\n{}", guidance.join(" "))
    }
}

fn config(ctx: &ToolContext) -> Result<&MediaConfig, ToolError> {
    let media = ctx.media.as_ref().ok_or_else(|| {
        ToolError::ExecutionFailed(
            "media provider is not configured; configure a OneAPI-compatible provider first".into(),
        )
    })?;
    if media.base_url.trim().is_empty() || media.api_key.trim().is_empty() {
        return Err(ToolError::ExecutionFailed(
            "media provider credentials are unavailable".into(),
        ));
    }
    Ok(media)
}

fn input_path_risk(
    ctx: &ToolContext,
    input: &Value,
    field: &str,
    level: RiskLevel,
    reason: &str,
) -> Risk {
    let Some(path) = input.get(field).and_then(Value::as_str) else {
        return Risk {
            level: RiskLevel::Blocked,
            reason: format!("missing {field}"),
        };
    };
    match ctx.resolve_read_path(path) {
        Ok(_) => Risk {
            level,
            reason: reason.into(),
        },
        Err(error) => Risk {
            level: RiskLevel::Blocked,
            reason: error.to_string(),
        },
    }
}

fn url(media: &MediaConfig, path: &str) -> String {
    format!(
        "{}/{}",
        media.base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn client() -> Result<reqwest::Client, ToolError> {
    reqwest::Client::builder()
        .user_agent("miniQ-media/1")
        .build()
        .map_err(|e| ToolError::ExecutionFailed(format!("media client: {e}")))
}

async fn response_json(response: reqwest::Response) -> Result<Value, ToolError> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail: String = body.trim().chars().take(500).collect();
        return Err(ToolError::ExecutionFailed(if detail.is_empty() {
            format!("media provider returned HTTP {}", status.as_u16())
        } else {
            format!("media provider returned HTTP {}: {detail}", status.as_u16())
        }));
    }
    response
        .json()
        .await
        .map_err(|e| ToolError::ExecutionFailed(format!("invalid media response: {e}")))
}

fn media_dir(ctx: &ToolContext) -> Result<PathBuf, ToolError> {
    let dir = ctx
        .workspace
        .join(".miniq")
        .join("media")
        .join(&ctx.task_scope);
    std::fs::create_dir_all(&dir)
        .map_err(|e| ToolError::ExecutionFailed(format!("create media directory: {e}")))?;
    Ok(dir)
}

fn save_bytes(ctx: &ToolContext, extension: &str, bytes: &[u8]) -> Result<String, ToolError> {
    let path = media_dir(ctx)?.join(format!(
        "{}-{}.{}",
        chrono_like_timestamp(),
        uuid::Uuid::new_v4(),
        extension
    ));
    std::fs::write(&path, bytes)
        .map_err(|e| ToolError::ExecutionFailed(format!("save media: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

fn chrono_like_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn image_result(ctx: &ToolContext, value: &Value) -> Result<Value, ToolError> {
    let item = value
        .pointer("/data/0")
        .ok_or_else(|| ToolError::ExecutionFailed("image provider returned no image".into()))?;
    let bytes = if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| ToolError::ExecutionFailed(format!("invalid image data: {e}")))?
    } else if let Some(remote) = item.get("url").and_then(Value::as_str) {
        return Ok(json!({"kind":"image", "url": remote, "provider_response": "url"}));
    } else {
        return Err(ToolError::ExecutionFailed(
            "image provider returned no image data".into(),
        ));
    };
    let path = save_bytes(ctx, "png", &bytes)?;
    Ok(
        json!({"kind":"image", "path":path, "mimeType":"image/png", "assetId":uuid::Uuid::new_v4().to_string()}),
    )
}

fn image_path_output(_ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
    output
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| Path::new(p).is_file())
        .map(|path| {
            vec![ChatImage {
                path: path.into(),
                mime_type: "image/png".into(),
                detail: Default::default(),
            }]
        })
        .unwrap_or_default()
}

pub struct EditImageTool;
#[async_trait]
impl Tool for EditImageTool {
    fn name(&self) -> &str {
        "edit_image"
    }
    fn description(&self) -> &str {
        "Edit an existing image using natural language. Reuse the most recent generated image when the user asks to revise it."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(EditInput)).unwrap()
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        input_path_risk(
            ctx,
            input,
            "image_path",
            RiskLevel::Medium,
            "edit local image",
        )
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: EditInput = parse_input(raw)?;
        let media = config(ctx)?;
        let model = selected_model(media, "image", input.model, &media.image_model).await?;
        let path = ctx
            .resolve_read_path(&input.image_path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let file = tokio::fs::read(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read image: {e}")))?;
        let part = reqwest::multipart::Part::bytes(file)
            .file_name(
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            )
            .mime_str("image/png")
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        let form = reqwest::multipart::Form::new()
            .text("model", model)
            .text("prompt", input.prompt)
            .part("image", part);
        let response = client()?
            .post(url(media, "/images/edits"))
            .bearer_auth(&media.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("image edit request: {e}")))?;
        image_result(ctx, &response_json(response).await?)
    }
    fn output_images(&self, ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
        image_path_output(ctx, output)
    }
}

/// Detects the image formats accepted for video reference frames.
fn video_reference_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn valid_music_clip_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub struct GetMusicGenerationTool;
#[async_trait]
impl Tool for GetMusicGenerationTool {
    fn name(&self) -> &str {
        "get_music_generation"
    }
    fn description(&self) -> &str {
        "Query the status and result of a music clip by its clip id."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(MusicGenerationQueryInput)).unwrap()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "query music generation".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: MusicGenerationQueryInput = parse_input(raw)?;
        if !valid_music_clip_id(&input.clip_id) {
            return Err(ToolError::InvalidInput(
                "clip_id must be a non-empty path-safe identifier".into(),
            ));
        }
        let media = config(ctx)?;
        let value = response_json(
            client()?
                .get(url(media, &format!("/music/clips/{}", input.clip_id)))
                .bearer_auth(&media.api_key)
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("music status request: {e}")))?,
        )
        .await?;
        Ok(json!({"kind":"music_task","task":value,"resume":true}))
    }
}

pub struct GetMusicClipsTool;
#[async_trait]
impl Tool for GetMusicClipsTool {
    fn name(&self) -> &str {
        "get_music_clips"
    }
    fn description(&self) -> &str {
        "Query 1 to 20 music clips by their ids. Poll every 10 to 20 seconds while pending, partial or running. Stop at succeeded or failed; use non-empty audio_url on success and error.message on failure."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(MusicClipsQueryInput)).unwrap()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "query music generation clips".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: MusicClipsQueryInput = parse_input(raw)?;
        if input.clip_ids.is_empty()
            || input.clip_ids.len() > 20
            || input.clip_ids.iter().any(|id| !valid_music_clip_id(id))
        {
            return Err(ToolError::InvalidInput(
                "clip_ids must contain 1 to 20 non-empty path-safe identifiers".into(),
            ));
        }
        let media = config(ctx)?;
        let ids = input.clip_ids.join(",");
        let value = response_json(
            client()?
                .get(url(media, &format!("/music/clips?ids={ids}")))
                .bearer_auth(&media.api_key)
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("music clips request: {e}")))?,
        )
        .await?;
        Ok(json!({"kind":"music_task","task":value,"resume":true}))
    }
}

#[cfg(test)]
#[path = "media/contract_tests.rs"]
mod contract_tests;

#[cfg(test)]
#[path = "media/live_constraints_tests.rs"]
mod live_constraints_tests;

#[cfg(test)]
#[path = "media_request_tests.rs"]
mod request_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn image_response_is_saved_as_a_host_asset() {
        let dir = tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().to_path_buf());
        let value = json!({"data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode([137_u8,80,78,71])}]});
        let out = image_result(&ctx, &value).unwrap();
        let path = out["path"].as_str().unwrap();
        assert!(Path::new(path).is_file());
        assert!(Path::new(path).starts_with(dir.path().join(".miniq").join("media")));
    }

    #[tokio::test]
    async fn media_tools_fail_closed_without_provider_credentials() {
        let ctx = ToolContext::new(tempdir().unwrap().path().to_path_buf());
        let error = GenerateImageTool
            .execute(&ctx, json!({"prompt":"x"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("media provider"));
    }

    #[test]
    fn schemas_keep_media_parameters_small_and_explicit() {
        let names = [
            GenerateImageTool.spec().name,
            EditImageTool.spec().name,
            GenerateVideoTool.spec().name,
            GetVideoGenerationTool.spec().name,
            SynthesizeSpeechTool.spec().name,
            TranscribeAudioTool.spec().name,
            GenerateMusicTool.spec().name,
            GetMusicGenerationTool.spec().name,
            GetMusicClipsTool.spec().name,
        ];
        assert_eq!(
            names,
            [
                "generate_image",
                "edit_image",
                "generate_video",
                "get_video_generation",
                "synthesize_speech",
                "transcribe_audio",
                "generate_music",
                "get_music_generation",
                "get_music_clips"
            ]
        );
    }
}
