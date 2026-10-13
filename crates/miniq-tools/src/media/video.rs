use super::*;

pub struct GenerateVideoTool;
#[async_trait]
impl Tool for GenerateVideoTool {
    fn name(&self) -> &str {
        "generate_video"
    }
    fn description(&self) -> &str {
        "Start a video task. Grok accepts local image paths. MiniMax H3 accepts HTTP(S) URLs or authorized local media. Local media uses temporary private storage. Preserve request_id and model. Use get_video_generation to poll and download the result. Do not submit the same task twice."
    }
    fn parameters_schema(&self) -> Value {
        video_schema()
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        if input.get("image_path").is_some_and(|path| !path.is_null()) {
            let risk = input_path_risk(ctx, input, "image_path", RiskLevel::High, "generate video");
            if risk.level == RiskLevel::Blocked {
                return risk;
            }
        }
        for field in ["reference_images", "reference_videos", "reference_audios"] {
            if let Some(paths) = input.get(field).and_then(Value::as_array) {
                for path in paths {
                    let Some(path) = path.as_str() else {
                        return Risk {
                            level: RiskLevel::Blocked,
                            reason: format!("{field} must contain strings"),
                        };
                    };
                    // URL references are forwarded to the provider, not opened locally.
                    if reference_http_url(path).is_ok() {
                        continue;
                    }
                    if let Err(error) = ctx.resolve_read_path(path) {
                        return Risk {
                            level: RiskLevel::Blocked,
                            reason: format!("{field}: {error}"),
                        };
                    }
                }
            }
        }
        Risk {
            level: RiskLevel::High,
            reason:
                "generate video; upload selected local H3 references to temporary private storage"
                    .into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: VideoInput = parse_input(raw.clone())?;
        let media = config(ctx)?;
        if input.prompt.trim().is_empty() {
            return Err(ToolError::InvalidInput("prompt must not be empty".into()));
        }
        if input.image_path.is_some() && input.reference_images.is_some() {
            return Err(ToolError::InvalidInput(
                "image_path and reference_images cannot be used together".into(),
            ));
        }
        let model = selected_model(media, "video", input.model.clone(), &media.video_model).await?;
        validate_h3_model(&model)?;
        if is_h3_model(&model) {
            return execute_h3(ctx, media, model, input, raw).await;
        }
        validate_parameters(media, "generate_video", &model, &raw, &grok_video_schema())?;
        if input.reference_videos.is_some() || input.reference_audios.is_some() {
            return Err(ToolError::InvalidInput(
                "reference_videos and reference_audios require a MiniMax H3 model".into(),
            ));
        }
        let mut body = json!({"model":model,"prompt":input.prompt});
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
            body["image"] = reference_image(ctx, &path).await?;
        }
        if let Some(paths) = input.reference_images {
            let mut references = Vec::with_capacity(paths.len());
            for path in paths {
                references.push(reference_image(ctx, &path).await?);
            }
            body["reference_images"] = Value::Array(references);
        }
        let value = response_json(
            client()?
                .post(url(media, "/videos/generations"))
                .bearer_auth(&media.api_key)
                .json(&ModelFirstRequest(&body))
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("video request: {e}")))?,
        )
        .await?;
        Ok(
            json!({"kind":"video_task","request_id":value.get("request_id").or_else(|| value.get("id")),"model":model,"task":value,"resume":true}),
        )
    }
}

async fn reference_image(ctx: &ToolContext, path: &str) -> Result<Value, ToolError> {
    let path = ctx
        .resolve_read_path(path)
        .map_err(|error| ToolError::SandboxDenied(error.to_string()))?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    let mime = video_reference_mime(&bytes).ok_or_else(|| {
        ToolError::InvalidInput("video reference must be a JPEG, PNG or WebP image".into())
    })?;
    Ok(
        json!({"url":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))}),
    )
}

pub(super) fn is_h3_model(model: &str) -> bool {
    matches!(model, "minimax-h3-768p" | "minimax-h3-2k")
}

pub(super) fn validate_h3_model(model: &str) -> Result<(), ToolError> {
    if model.to_ascii_lowercase().starts_with("minimax-h3-") && !is_h3_model(model) {
        return Err(ToolError::InvalidInput(
            "Unsupported H3 model. Select minimax-h3-768p or minimax-h3-2k.".into(),
        ));
    }
    Ok(())
}

fn reference_http_url(value: &str) -> Result<(), ToolError> {
    let valid = url::Url::parse(value).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    });
    if valid {
        Ok(())
    } else {
        Err(ToolError::InvalidInput("H3 references require HTTP(S) URLs without embedded credentials. Upload local files before submitting.".into()))
    }
}

async fn execute_h3(
    ctx: &ToolContext,
    media: &MediaConfig,
    model: String,
    input: VideoInput,
    mut raw: Value,
) -> Result<Value, ToolError> {
    if input.resolution.is_some() {
        return Err(ToolError::InvalidInput(
            "H3 resolution is selected by the model ID. Omit resolution.".into(),
        ));
    }
    let mut input = input;
    if let Some(path) = input.image_path.take() {
        input.reference_images = Some(vec![path]);
        raw.as_object_mut().unwrap().remove("image_path");
        raw["reference_images"] = json!(input.reference_images);
    }
    let seconds = input.duration.unwrap_or(8);
    raw["duration"] = seconds.into();
    // Channel schemas describe provider wire URLs, while this tool also
    // accepts local paths. Validate scalar/count constraints before uploading.
    for field in ["reference_images", "reference_videos", "reference_audios"] {
        if let Some(values) = raw.get_mut(field).and_then(Value::as_array_mut) {
            for value in values {
                if value
                    .as_str()
                    .is_some_and(|s| reference_http_url(s).is_err())
                {
                    *value = json!("https://media-preflight.invalid/reference");
                }
            }
        }
    }
    validate_parameters(media, "generate_video", &model, &raw, &h3_video_schema())?;
    let mut body = json!({"model":model,"prompt":input.prompt,"seconds":seconds});
    if let Some(ratio) = input.aspect_ratio {
        body["ratio"] = ratio.into();
    }
    let mut total_bytes = 0usize;
    let mut prepared = Vec::new();
    // Validate every local file before any upload or paid generation request.
    for (field, paths, kind) in [
        (
            "reference_images",
            input.reference_images,
            ReferenceKind::Image,
        ),
        (
            "reference_videos",
            input.reference_videos,
            ReferenceKind::Video,
        ),
        (
            "reference_audios",
            input.reference_audios,
            ReferenceKind::Audio,
        ),
    ] {
        if let Some(paths) = paths {
            let mut references = Vec::with_capacity(paths.len());
            for path in &paths {
                references.push(prepare_h3_reference(ctx, path, kind, &mut total_bytes).await?);
            }
            prepared.push((field, references));
        }
    }
    let uploaded_local_media = total_bytes > 0;
    for (field, references) in prepared {
        let mut urls = Vec::with_capacity(references.len());
        for reference in references {
            if ctx.cancellation.is_cancelled() {
                return Err(ToolError::ExecutionFailed("media upload cancelled".into()));
            }
            urls.push(upload_h3_reference(ctx, reference).await?);
        }
        body[field] = json!(urls);
    }
    if ctx.cancellation.is_cancelled() {
        return Err(ToolError::ExecutionFailed(
            "video submission cancelled".into(),
        ));
    }
    let task = response_json(
        client()?
            .post(url(media, "/videos/std/generations"))
            .bearer_auth(&media.api_key)
            .json(&ModelFirstRequest(&body))
            .send()
            .await
            .map_err(|error| ToolError::ExecutionFailed(format!("H3 video request: {error}")))?,
    )
    .await;
    let mut task = task.map_err(|error| {
        if uploaded_local_media { ToolError::ExecutionFailed("H3 rejected the video request after reference upload; no automatic resubmission was performed".into()) }
        else { error }
    })?;
    redact_storage_urls(&mut task);
    let request_id = task
        .get("id")
        .or_else(|| task.get("task_id"))
        .and_then(Value::as_str)
        .filter(|id| valid_music_clip_id(id))
        .ok_or_else(|| {
            ToolError::ExecutionFailed(
                "H3 response did not include a path-safe task id. Do not resubmit the generation."
                    .into(),
            )
        })?;
    let metadata_error = remember_video_model(ctx, media, request_id, &model)
        .err()
        .map(|error| error.to_string());
    Ok(
        json!({"kind":"video_task", "request_id":request_id, "model":model,
        "protocol":"minimax-h3", "task":task, "resume":true,"metadata_error":metadata_error}),
    )
}

#[derive(Clone, Copy)]
enum ReferenceKind {
    Image,
    Video,
    Audio,
}

impl ReferenceKind {
    fn label(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Image => 20 * 1024 * 1024,
            Self::Video => 200 * 1024 * 1024,
            Self::Audio => 50 * 1024 * 1024,
        }
    }
}

const MAX_H3_REFERENCE_BYTES: usize = 300 * 1024 * 1024;

enum PreparedReference {
    Url(String),
    Local {
        bytes: Vec<u8>,
        content_type: &'static str,
    },
}

pub(super) fn redact_storage_urls(value: &mut Value) {
    match value {
        Value::String(text)
            if url::Url::parse(text).ok().is_some_and(|url| {
                url.host_str()
                    .is_some_and(|host| host.ends_with(".qiniucs.com"))
            }) =>
        {
            *text = "[temporary media reference]".into();
        }
        Value::Array(values) => values.iter_mut().for_each(redact_storage_urls),
        Value::Object(fields) => fields.values_mut().for_each(redact_storage_urls),
        _ => {}
    }
}

async fn prepare_h3_reference(
    ctx: &ToolContext,
    value: &str,
    kind: ReferenceKind,
    total_bytes: &mut usize,
) -> Result<PreparedReference, ToolError> {
    if reference_http_url(value).is_ok() {
        return Ok(PreparedReference::Url(value.to_owned()));
    }
    if value.contains("://") || value.starts_with("data:") || value.starts_with("blob:") {
        return Err(ToolError::InvalidInput(format!(
            "{} reference must be an HTTP(S) URL or a local file",
            kind.label()
        )));
    }
    let path = ctx
        .resolve_read_path(value)
        .map_err(|error| ToolError::SandboxDenied(error.to_string()))?;
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|error| {
            ToolError::ExecutionFailed(format!("read {} reference: {error}", kind.label()))
        })?
        .len() as usize;
    if size > kind.max_bytes() {
        return Err(ToolError::InvalidInput(format!(
            "{} reference exceeds the {} MiB limit",
            kind.label(),
            kind.max_bytes() / (1024 * 1024)
        )));
    }
    if total_bytes.saturating_add(size) > MAX_H3_REFERENCE_BYTES {
        return Err(ToolError::InvalidInput(
            "H3 references exceed the 300 MiB total request limit".into(),
        ));
    }
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ToolError::ExecutionFailed("reference file could not be read".into()))?;
    let mut bytes = Vec::new();
    file.take((kind.max_bytes() + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ToolError::ExecutionFailed("reference file could not be read".into()))?;
    if bytes.is_empty() || bytes.len() != size || bytes.len() > kind.max_bytes() {
        return Err(ToolError::InvalidInput(
            "reference file is empty, too large or changed while reading".into(),
        ));
    }
    let content_type = detect_h3_mime(&bytes, kind).ok_or_else(|| {
        ToolError::InvalidInput(format!(
            "unsupported or invalid {} reference MIME",
            kind.label()
        ))
    })?;
    *total_bytes += bytes.len();
    Ok(PreparedReference::Local {
        bytes,
        content_type,
    })
}

async fn upload_h3_reference(
    ctx: &ToolContext,
    reference: PreparedReference,
) -> Result<String, ToolError> {
    let (bytes, content_type) = match reference {
        PreparedReference::Url(url) => return Ok(url),
        PreparedReference::Local {
            bytes,
            content_type,
        } => (bytes, content_type),
    };
    let size = bytes.len();
    let uploader = ctx.provider_media_uploader.as_ref().ok_or_else(|| {
        ToolError::ExecutionFailed(
            "local H3 media upload is unavailable for this channel; use HTTPS references or the supported OneAPI channel".into(),
        )
    })?;
    let reference = tokio::select! {
        _ = ctx.cancellation.cancelled() => return Err(ToolError::ExecutionFailed("media upload cancelled".into())),
        result = uploader.upload(bytes, content_type) => result.map_err(|_| ToolError::ExecutionFailed("reference media upload failed; video generation was not submitted".into()))?,
    };
    let url = url::Url::parse(&reference.url)
        .map_err(|_| ToolError::ExecutionFailed("media uploader returned an invalid URL".into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ToolError::ExecutionFailed(
            "media uploader returned a non-HTTPS URL".into(),
        ));
    }
    if reference.content_type != content_type || reference.bytes != size {
        return Err(ToolError::ExecutionFailed(
            "media uploader returned inconsistent media metadata".into(),
        ));
    }
    Ok(reference.url)
}

fn detect_h3_mime(bytes: &[u8], kind: ReferenceKind) -> Option<&'static str> {
    let detected = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(brand, b"isom" | b"iso2" | b"mp41" | b"mp42") {
            Some("video/mp4")
        } else if brand == b"qt  " {
            Some("video/quicktime")
        } else if matches!(brand, b"M4A " | b"M4B ") {
            Some("audio/mp4")
        } else {
            None
        }
    } else if bytes.starts_with(b"\x1A\x45\xDF\xA3") {
        Some("video/webm")
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0)
    {
        Some("audio/mpeg")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        Some("audio/wav")
    } else if bytes.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if bytes.starts_with(b"fLaC") {
        Some("audio/flac")
    } else {
        None
    }?;
    match kind {
        ReferenceKind::Image if detected.starts_with("image/") => Some(detected),
        ReferenceKind::Video if detected.starts_with("video/") => Some(detected),
        ReferenceKind::Audio if detected.starts_with("audio/") => Some(detected),
        _ => None,
    }
}

fn video_metadata_path(ctx: &ToolContext, request_id: &str) -> Result<PathBuf, ToolError> {
    if !valid_music_clip_id(request_id) {
        return Err(ToolError::InvalidInput(
            "request_id must be a path-safe identifier".into(),
        ));
    }
    ctx.resolve_path(&format!(".miniq/media/video-tasks/{request_id}.json"))
        .map_err(|error| ToolError::SandboxDenied(error.to_string()))
}

fn remember_video_model(
    ctx: &ToolContext,
    media: &MediaConfig,
    request_id: &str,
    model: &str,
) -> Result<(), ToolError> {
    let path = video_metadata_path(ctx, request_id)?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    let bytes =
        serde_json::to_vec(&json!({"base_url":media.base_url.trim_end_matches('/'),"model":model}))
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    std::fs::write(path, bytes).map_err(|error| ToolError::ExecutionFailed(error.to_string()))
}

pub(super) fn saved_video_model(
    ctx: &ToolContext,
    media: &MediaConfig,
    request_id: &str,
) -> Result<Option<String>, ToolError> {
    let path = video_metadata_path(ctx, request_id)?;
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ToolError::ExecutionFailed(error.to_string())),
    };
    let metadata: Value = serde_json::from_slice(&bytes).map_err(|error| {
        ToolError::ExecutionFailed(format!("invalid video task metadata: {error}"))
    })?;
    if metadata["base_url"].as_str() != Some(media.base_url.trim_end_matches('/')) {
        return Err(ToolError::InvalidInput(
            "Video task belongs to another media channel.".into(),
        ));
    }
    let model = metadata["model"]
        .as_str()
        .filter(|model| is_h3_model(model))
        .ok_or_else(|| ToolError::ExecutionFailed("invalid saved video model".into()))?;
    Ok(Some(model.into()))
}

#[cfg(test)]
#[path = "video_local_tests.rs"]
mod local_reference_tests;
