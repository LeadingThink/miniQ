use super::video::{is_h3_model, saved_video_model, validate_h3_model};
use super::*;

pub struct GetVideoGenerationTool;
#[async_trait]
impl Tool for GetVideoGenerationTool {
    fn name(&self) -> &str {
        "get_video_generation"
    }
    fn description(&self) -> &str {
        "Query a video generation task by request_id. Pass model for MiniMax H3 tasks. When the task is done, the video is downloaded into the workspace and its local path is returned."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(VideoGenerationQueryInput)).unwrap()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "query video generation".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        let mut input: VideoGenerationQueryInput = parse_input(raw)?;
        if !valid_music_clip_id(&input.request_id) {
            return Err(ToolError::InvalidInput(
                "request_id must be a non-empty path-safe identifier".into(),
            ));
        }
        if input
            .model
            .as_ref()
            .is_some_and(|model| model.trim().is_empty() || model.chars().any(char::is_control))
        {
            return Err(ToolError::InvalidInput(
                "model must be a nonempty model ID".into(),
            ));
        }
        let media = config(ctx)?;
        if let Some(saved) = saved_video_model(ctx, media, &input.request_id)? {
            if input.model.as_ref().is_some_and(|model| model != &saved) {
                return Err(ToolError::InvalidInput(
                    "model differs from the saved video task model".into(),
                ));
            }
            input.model = Some(saved);
        }
        if let Some(model) = input.model.as_deref() {
            validate_h3_model(model)?;
        }
        let http = client()?;
        let h3 = input.model.as_deref().is_some_and(is_h3_model);
        let status_path = if h3 {
            format!("/videos/std/generations/{}", input.request_id)
        } else {
            format!("/videos/{}", input.request_id)
        };
        let task = response_json(
            http.get(url(media, &status_path))
                .bearer_auth(&media.api_key)
                .send()
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("video status request: {e}")))?,
        )
        .await?;
        let status = task.get("status").and_then(Value::as_str);
        if matches!(status, Some("failed" | "error")) {
            return Ok(
                json!({"kind":"video_task","request_id":input.request_id,"model":input.model,"task":task,"resume":false}),
            );
        }
        let completed = if h3 {
            status == Some("completed")
        } else {
            status == Some("done")
        };
        let video_url = task
            .pointer("/video/url")
            .and_then(Value::as_str)
            .filter(|_| completed && !h3);
        let target = if let Some(video_url) = video_url {
            let base = reqwest::Url::parse(&media.base_url)
                .map_err(|e| ToolError::ExecutionFailed(format!("invalid media base url: {e}")))?;
            base.join(video_url)
                .map_err(|e| ToolError::ExecutionFailed(format!("invalid video url: {e}")))?
        } else if h3 && completed {
            reqwest::Url::parse(&url(
                media,
                &format!("/videos/std/generations/{}/content", input.request_id),
            ))
            .map_err(|e| ToolError::ExecutionFailed(format!("invalid H3 content url: {e}")))?
        } else {
            return Ok(
                json!({"kind":"video_task","request_id":input.request_id,"model":input.model,"task":task,"resume":true}),
            );
        };
        let base = reqwest::Url::parse(&media.base_url)
            .map_err(|e| ToolError::ExecutionFailed(format!("invalid media base url: {e}")))?;
        // Only send the provider credential back to the provider's own origin.
        let mut request = http.get(target.clone());
        if target.origin() == base.origin() {
            request = request.bearer_auth(&media.api_key);
        }
        let response = request
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("video download: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(ToolError::ExecutionFailed(format!(
                "video download returned HTTP {}",
                status.as_u16()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("video download: {e}")))?;
        let path = save_bytes(ctx, "mp4", &bytes)?;
        Ok(json!({
            "kind":"video_task",
            "request_id":input.request_id,
            "model":input.model,
            "task":task,
            "resume":false,
            "video":{"kind":"video","path":path,"mimeType":"video/mp4"}
        }))
    }
}
