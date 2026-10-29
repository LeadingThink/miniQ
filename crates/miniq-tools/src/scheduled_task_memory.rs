use crate::router::{parse_input, Tool, ToolContext, ToolError};
use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};
/// Write only the current scheduled run's task memory. The daemon validates
/// task id, run id and revision in one SQL transaction.
pub struct ScheduledTaskMemoryWriteTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTaskMemoryInput {
    content: String,
}

#[async_trait]
impl Tool for ScheduledTaskMemoryWriteTool {
    fn name(&self) -> &str {
        "scheduled_task_memory_write"
    }
    fn description(&self) -> &str {
        "Update the memory of this scheduled task for future runs. Only call when a durable, confirmed fact changed; this is scoped to the current scheduled run."
    }
    fn parameters_schema(&self) -> Value {
        json!({"type":"object","properties":{"content":{"type":"string"}},"required":["content"]})
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "updates scheduled task memory".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let Some(scope) = &ctx.scheduled_task else {
            return Err(ToolError::ExecutionFailed(
                "scheduled task memory is only available during a scheduled run".into(),
            ));
        };
        let input: ScheduledTaskMemoryInput = parse_input(input)?;
        if input.content.trim().is_empty() {
            return Err(ToolError::InvalidInput("content is empty".into()));
        }
        scope
            .store
            .write_scheduled_task_memory(
                &scope.run_id,
                &scope.task_id,
                scope.task_revision,
                input.content.trim(),
            )
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
        Ok(json!({"saved": true, "taskId": scope.task_id, "runId": scope.run_id}))
    }
}
