use super::*;

pub struct SynthesizeSpeechTool;
#[async_trait]
impl Tool for SynthesizeSpeechTool {
    fn name(&self) -> &str {
        "synthesize_speech"
    }
    fn description(&self) -> &str {
        super::speech::SPEECH_DESCRIPTION
    }
    fn parameters_schema(&self) -> Value {
        speech_schema()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "synthesize speech".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: SpeechInput = parse_input(raw)?;
        if input.input.trim().is_empty() {
            return Err(ToolError::InvalidInput("input must not be blank".into()));
        }
        let media = config(ctx)?;
        let preferred = if media.tts_model.trim().is_empty() {
            "grok-tts"
        } else {
            &media.tts_model
        };
        let model = tokio::select! {
            biased;
            _ = ctx.cancellation.cancelled() => return Err(super::speech::cancelled()),
            result = selected_model(media, "tts", input.model.clone(), preferred) => result?,
        };
        let baseline = speech_schema_for(media, &model);
        let body = super::speech::request_body(media, model, input, &baseline)?;
        validate_parameters(
            media,
            "synthesize_speech",
            body["model"].as_str().unwrap(),
            &body,
            &baseline,
        )?;
        super::speech::validate_tags(
            media,
            body["model"].as_str().unwrap(),
            body["input"].as_str().unwrap(),
        )?;
        let request = client()?
            .post(url(media, "/audio/speech"))
            .bearer_auth(&media.api_key)
            .json(&ModelFirstRequest(&body))
            .send();
        let response = tokio::select! {
            biased;
            _ = ctx.cancellation.cancelled() => return Err(super::speech::cancelled()),
            result = request => result.map_err(|e| ToolError::ExecutionFailed(format!("speech request: {e}")))?,
        };
        if !response.status().is_success() {
            return Err(ToolError::ExecutionFailed(format!(
                "speech provider returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let format = body["response_format"].as_str().unwrap();
        let mime = super::speech::response_mime(format, &response);
        let bytes = super::speech::read_response(ctx, response).await?;
        let extension = if format
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            format
        } else {
            "bin"
        };
        let path = save_bytes(ctx, extension, &bytes)?;
        Ok(json!({"kind":"audio","path":path,"mimeType":mime}))
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
