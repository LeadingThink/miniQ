use super::*;

pub struct GenerateImageTool;
#[async_trait]
impl Tool for GenerateImageTool {
    fn name(&self) -> &str {
        "generate_image"
    }
    fn description(&self) -> &str {
        "Generate an image from a prompt. Describe the layout and aspect ratio in prompt. Parameter effects depend on the channel. Return the image to the user."
    }
    fn parameters_schema(&self) -> Value {
        image_schema()
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
        if input.prompt.trim().is_empty() {
            return Err(ToolError::InvalidInput("prompt must not be empty".into()));
        }
        let model = selected_model(media, "image", input.model.clone(), &media.image_model).await?;
        let http = client()?;
        let body = image_request_body(media, model.clone(), input);
        validate_parameters(media, "generate_image", &model, &body, &image_schema())?;
        let response = http
            .post(url(media, "/images/generations"))
            .bearer_auth(&media.api_key)
            .json(&ModelFirstRequest(&body))
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("image request: {e}")))?;
        image_result(ctx, &response_json(response).await?)
    }
    fn output_images(&self, ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
        image_path_output(ctx, output)
    }
}
