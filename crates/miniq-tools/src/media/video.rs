use super::*;

pub struct GenerateVideoTool;
#[async_trait]
impl Tool for GenerateVideoTool {
    fn name(&self) -> &str {
        "generate_video"
    }
    fn description(&self) -> &str {
        "Start a video task. Grok accepts local image paths. MiniMax H3 accepts HTTP(S) reference URLs. Preserve request_id and model. Use get_video_generation to poll and download the result. Do not submit the same task twice."
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
            reason: "generate video".into(),
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
    if input.image_path.is_some() {
        return Err(ToolError::InvalidInput(
            "H3 uses reference_images instead of image_path".into(),
        ));
    }
    if input.resolution.is_some() {
        return Err(ToolError::InvalidInput(
            "H3 resolution is selected by the model ID. Omit resolution.".into(),
        ));
    }
    let seconds = input.duration.unwrap_or(8);
    raw["duration"] = seconds.into();
    validate_parameters(media, "generate_video", &model, &raw, &h3_video_schema())?;
    let mut body = json!({"model":model,"prompt":input.prompt,"seconds":seconds});
    if let Some(ratio) = input.aspect_ratio {
        body["ratio"] = ratio.into();
    }
    for (field, paths) in [
        ("reference_images", input.reference_images),
        ("reference_videos", input.reference_videos),
        ("reference_audios", input.reference_audios),
    ] {
        if let Some(paths) = paths {
            for path in &paths {
                if reference_http_url(path).is_err() {
                    // Preserve workspace escape rejection for local inputs without reading them.
                    if !path.contains("://") {
                        ctx.resolve_read_path(path)
                            .map_err(|error| ToolError::SandboxDenied(error.to_string()))?;
                    }
                    reference_http_url(path)?;
                }
            }
            body[field] = json!(paths);
        }
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
    .await?;
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
