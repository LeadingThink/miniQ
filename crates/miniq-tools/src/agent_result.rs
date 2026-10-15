//! Agent results have their own contract; process byte cursors never apply.
use crate::{Tool, ToolContext, ToolError};
use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ResultInput {
    #[schemars(regex(pattern = "^agent_"))]
    id: String,
}
pub struct AgentResultTool;
#[async_trait]
impl Tool for AgentResultTool {
    fn name(&self) -> &str {
        "agent_result"
    }
    fn description(&self) -> &str {
        "Read the complete result and status of one session-owned agent without blocking. Use agent_wait with all outstanding IDs to wait for any completion; remove collected IDs before waiting again. No shell byte cursors or output budgets apply. A running status is not a final result."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(ResultInput)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "reads session-owned agent result".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: ResultInput = crate::router::parse_input(input)?;
        if !input.id.starts_with("agent_") {
            return Err(ToolError::InvalidInput(
                "agent_result requires an agent_* ID".into(),
            ));
        }
        ctx.agents
            .as_ref()
            .ok_or_else(|| ToolError::ExecutionFailed("agent runtime unavailable".into()))?
            .output(&input.id, false, Duration::ZERO)
            .await
    }
}
