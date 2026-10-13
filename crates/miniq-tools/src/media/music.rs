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
        // Null optional values request the same defaults as omitted values.
        // Normalize the parsing copy because MusicInput's bool rejects null.
        let mut parsed = raw.clone();
        if parsed.get("instrumental").is_some_and(Value::is_null) {
            parsed.as_object_mut().unwrap().remove("instrumental");
        }
        let input: MusicInput = parse_input(parsed)?;
        let media = config(_ctx)?;
        let model = selected_model(media, "music", input.model, &media.music_model).await?;
        let mode = input
            .mode
            .map(Value::String)
            .unwrap_or_else(|| music_default(media, &model, "mode", json!("simple")));
        let mode = mode.as_str().ok_or_else(|| {
            ToolError::InvalidInput("mode default must be simple or custom".into())
        })?;
        let instrumental = if raw
            .get("instrumental")
            .is_some_and(|value| !value.is_null())
        {
            input.instrumental
        } else {
            music_default(media, &model, "instrumental", json!(false))
                .as_bool()
                .ok_or_else(|| {
                    ToolError::InvalidInput("instrumental default must be a boolean".into())
                })?
        };
        if !matches!(mode, "simple" | "custom") {
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
            if !instrumental && prompt.is_none() {
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
            "instrumental": instrumental,
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
        validate_parameters(media, "generate_music", &model, &body, &music_schema())?;
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

fn music_default(media: &MediaConfig, model: &str, field: &str, fallback: Value) -> Value {
    media
        .capabilities
        .as_ref()
        .and_then(|registry| registry.snapshot(&media.base_url))
        .and_then(|snapshot| {
            snapshot
                .parameter_schema("generate_music", model, field)?
                .get("default")
                .cloned()
        })
        .unwrap_or(fallback)
}
