use super::*;

pub struct GenerateMusicTool;
#[async_trait]
impl Tool for GenerateMusicTool {
    fn name(&self) -> &str {
        "generate_music"
    }
    fn description(&self) -> &str {
        "Start music generation and preserve all returned clips[].id values. Poll them with get_music_clips; do not submit the same generation twice."
    }
    fn parameters_schema(&self) -> Value {
        music_schema()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::High,
            reason: "generate music".into(),
        }
    }
    async fn execute(&self, _ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let input: MusicInput = parse_input(raw.clone())?;
        let media = config(_ctx)?;
        let model = selected_model(media, "music", input.model, &media.music_model).await?;
        validate_parameters(media, "generate_music", &model, &raw, &music_schema())?;
        let mode = input.mode.unwrap_or_else(|| "simple".into());
        if !matches!(mode.as_str(), "simple" | "custom") {
            return Err(ToolError::InvalidInput(
                "mode must be simple or custom".into(),
            ));
        }
        let prompt = (!input.prompt.trim().is_empty()).then_some(input.prompt);
        let style = nonempty_string(input.style, "style")?;
        let title = nonempty_string(input.title, "title")?;
        if mode == "custom" {
            if style.is_none() || title.is_none() {
                return Err(ToolError::InvalidInput(
                    "custom music mode requires style and title".into(),
                ));
            }
            if !input.instrumental && prompt.is_none() {
                return Err(ToolError::InvalidInput(
                    "custom vocal music requires prompt lyrics".into(),
                ));
            }
        }
        if mode == "simple" && prompt.is_none() {
            return Err(ToolError::InvalidInput(
                "simple music mode requires prompt".into(),
            ));
        }
        let vocal_gender = input.vocal_gender;
        let mut body = json!({
            "model": model,
            "mode": mode,
            "prompt": prompt.unwrap_or_default(),
            "instrumental": input.instrumental,
        });
        for (field, value) in [
            ("style", style),
            ("title", title),
            ("negative_style", input.negative_style),
            ("vocal_gender", vocal_gender),
        ] {
            if let Some(value) = value {
                body[field] = value.into();
            }
        }
        if let Some(value) = input.style_weight {
            body["style_weight"] = json!(value);
        }
        if let Some(value) = input.weirdness {
            body["weirdness"] = json!(value);
        }
        let value = response_json(
            client()?
                .post(url(media, "/music/generations"))
                .bearer_auth(&media.api_key)
                .json(&ModelFirstRequest(&body))
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("music request: {e}")))?,
        )
        .await?;
        Ok(json!({"kind":"music_task","task":value,"resume":true}))
    }
}
