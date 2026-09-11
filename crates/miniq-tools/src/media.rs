//! Native, provider-agnostic media capabilities backed by the configured
//! OneAPI-compatible endpoint. Tools deliberately keep media out of the main
//! model picker: the chat model decides when a capability is appropriate.

use async_trait::async_trait;
use base64::Engine;
use miniq_models::ChatImage;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::file::path_risk;
use crate::router::{parse_input, MediaConfig, Tool, ToolContext, ToolError};

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ImageInput {
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    quality: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EditInput {
    prompt: String,
    image_path: String,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoInput {
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    duration: Option<u8>,
    #[serde(default)]
    resolution: Option<String>,
    #[serde(default)]
    aspect_ratio: Option<String>,
    #[serde(default)]
    image_path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SpeechInput {
    input: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    response_format: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct TranscribeInput {
    path: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MusicInput {
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    style: Option<String>,
    #[serde(default)]
    title: Option<String>,
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
        return Err(ToolError::ExecutionFailed(format!(
            "media provider returned HTTP {}",
            status.as_u16()
        )));
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

pub struct GenerateImageTool;
#[async_trait]
impl Tool for GenerateImageTool {
    fn name(&self) -> &str {
        "generate_image"
    }
    fn description(&self) -> &str {
        "Generate an image from a natural-language request. Use for posters, illustrations, diagrams, and visual assets; return the generated image to the user."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(ImageInput)).unwrap()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "generate media".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: ImageInput = parse_input(raw)?;
        let media = config(ctx)?;
        let http = client()?;
        let mut body = json!({"model": input.model.unwrap_or_else(|| media.image_model.clone()), "prompt": input.prompt});
        if let Some(v) = input.size {
            body["size"] = v.into();
        }
        if let Some(v) = input.quality {
            body["quality"] = v.into();
        }
        let response = http
            .post(url(media, "/images/generations"))
            .bearer_auth(&media.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("image request: {e}")))?;
        image_result(ctx, &response_json(response).await?)
    }
    fn output_images(&self, ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
        image_path_output(ctx, output)
    }
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
            .text(
                "model",
                input.model.unwrap_or_else(|| media.image_model.clone()),
            )
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

pub struct SynthesizeSpeechTool;
#[async_trait]
impl Tool for SynthesizeSpeechTool {
    fn name(&self) -> &str {
        "synthesize_speech"
    }
    fn description(&self) -> &str {
        "Turn text into natural speech and return a playable audio file."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(SpeechInput)).unwrap()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "synthesize speech".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: SpeechInput = parse_input(raw)?;
        let media = config(ctx)?;
        let format = input.response_format.unwrap_or_else(|| "mp3".into());
        let body = json!({"model": input.model.unwrap_or_else(|| media.tts_model.clone()), "input": input.input, "voice": input.voice.unwrap_or_else(|| "eve".into()), "response_format": format});
        let response = client()?
            .post(url(media, "/audio/speech"))
            .bearer_auth(&media.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("speech request: {e}")))?;
        if !response.status().is_success() {
            return Err(ToolError::ExecutionFailed(format!(
                "speech provider returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read speech: {e}")))?;
        let path = save_bytes(ctx, &format, &bytes)?;
        Ok(json!({"kind":"audio","path":path,"mimeType":format!("audio/{format}")}))
    }
}

pub struct TranscribeAudioTool;
#[async_trait]
impl Tool for TranscribeAudioTool {
    fn name(&self) -> &str {
        "transcribe_audio"
    }
    fn description(&self) -> &str {
        "Transcribe a local audio or video file into text."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(TranscribeInput)).unwrap()
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(ctx, input, RiskLevel::Low, "transcribe local media")
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: TranscribeInput = parse_input(raw)?;
        let media = config(ctx)?;
        let path = ctx
            .resolve_read_path(&input.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("read audio: {e}")))?;
        let part = reqwest::multipart::Part::bytes(bytes).file_name(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        );
        let mut form = reqwest::multipart::Form::new()
            .text(
                "model",
                input
                    .model
                    .unwrap_or_else(|| media.transcription_model.clone()),
            )
            .part("file", part);
        if let Some(lang) = input.language {
            form = form.text("language", lang);
        }
        let value = response_json(
            client()?
                .post(url(media, "/audio/transcriptions"))
                .bearer_auth(&media.api_key)
                .multipart(form)
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("transcription request: {e}")))?,
        )
        .await?;
        Ok(json!({"kind":"transcript","text":value.get("text").cloned().unwrap_or(value)}))
    }
}

pub struct GenerateVideoTool;
#[async_trait]
impl Tool for GenerateVideoTool {
    fn name(&self) -> &str {
        "generate_video"
    }
    fn description(&self) -> &str {
        "Start a video generation task. Returns its task id and status URL so the task can be resumed without submitting it twice."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(VideoInput)).unwrap()
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        match input.get("image_path") {
            Some(_) => input_path_risk(ctx, input, "image_path", RiskLevel::High, "generate video"),
            None => Risk {
                level: RiskLevel::High,
                reason: "generate video".into(),
            },
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: VideoInput = parse_input(raw)?;
        let media = config(ctx)?;
        let mut body = json!({"model":input.model.unwrap_or_else(|| media.video_model.clone()),"prompt":input.prompt});
        if let Some(v) = input.duration {
            body["duration"] = v.into();
        }
        if let Some(v) = input.resolution {
            body["resolution"] = v.into();
        }
        if let Some(v) = input.aspect_ratio {
            body["aspect_ratio"] = v.into();
        }
        if let Some(path) = input.image_path {
            let p = ctx
                .resolve_read_path(&path)
                .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
            let bytes = tokio::fs::read(p)
                .await
                .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
            body["image"] = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
            .into();
        }
        let value = response_json(
            client()?
                .post(url(media, "/videos/generations"))
                .bearer_auth(&media.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("video request: {e}")))?,
        )
        .await?;
        Ok(json!({"kind":"video_task","task":value,"resume":true}))
    }
}

pub struct GenerateMusicTool;
#[async_trait]
impl Tool for GenerateMusicTool {
    fn name(&self) -> &str {
        "generate_music"
    }
    fn description(&self) -> &str {
        "Start an original music generation task and return its clip id for progress polling."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(MusicInput)).unwrap()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::High,
            reason: "generate music".into(),
        }
    }
    async fn execute(&self, _ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: MusicInput = parse_input(raw)?;
        let media = config(_ctx)?;
        let body = json!({"model":input.model.unwrap_or_else(||media.music_model.clone()),"prompt":input.prompt,"instrumental":input.instrumental,"style":input.style,"title":input.title});
        let value = response_json(
            client()?
                .post(url(media, "/music/generations"))
                .bearer_auth(&media.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("music request: {e}")))?,
        )
        .await?;
        Ok(json!({"kind":"music_task","task":value,"resume":true}))
    }
}

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
        assert!(path.contains(".miniq/media"));
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
            SynthesizeSpeechTool.spec().name,
            TranscribeAudioTool.spec().name,
            GenerateMusicTool.spec().name,
        ];
        assert_eq!(
            names,
            [
                "generate_image",
                "edit_image",
                "generate_video",
                "synthesize_speech",
                "transcribe_audio",
                "generate_music"
            ]
        );
    }
}
