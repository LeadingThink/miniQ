use super::*;

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
            .json(&ModelFirstRequest(&body))
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
