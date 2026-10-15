//! Explicit agent lifecycle wait; process byte cursors never apply to agents.
use crate::{Tool, ToolContext, ToolError};
use async_trait::async_trait;
use futures_util::{stream::FuturesUnordered, StreamExt};
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitInput {
    #[schemars(length(min = 1))]
    ids: Vec<String>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 600000))]
    timeout_ms: Option<u64>,
}
pub struct AgentWaitTool;
#[async_trait]
impl Tool for AgentWaitTool {
    fn name(&self) -> &str {
        "agent_wait"
    }
    fn description(&self) -> &str {
        "Wait for any of the listed session-owned agents to finish, fail or stop. Returns a status map with final results and timed_out. Independent agents keep running. IDs must come from agent_run. This is a final-status wait, not the Codex v2 mailbox API."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(WaitInput)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "waits for session-owned agents".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: WaitInput = crate::router::parse_input(input)?;
        let timeout = input.timeout_ms.unwrap_or(30_000);
        if input.ids.is_empty()
            || input.ids.iter().any(|id| !id.starts_with("agent_"))
            || !(1..=600000).contains(&timeout)
        {
            return Err(ToolError::InvalidInput(
                "agent IDs and timeoutMs (1..600000) are required".into(),
            ));
        }
        let bridge = ctx
            .agents
            .as_ref()
            .ok_or_else(|| ToolError::ExecutionFailed("agent runtime unavailable".into()))?;
        // Validate every target before blocking on any of them.
        let mut ready = serde_json::Map::new();
        for id in &input.ids {
            let output = bridge.output(id, false, Duration::ZERO).await?;
            if terminal(&output) {
                ready.insert(id.clone(), output);
            }
        }
        if !ready.is_empty() {
            return Ok(json!({"status":ready,"timed_out":false}));
        }
        let mut waits = FuturesUnordered::new();
        for id in &input.ids {
            waits.push(async move {
                Ok::<_, ToolError>((
                    id,
                    bridge
                        .output(id, true, Duration::from_millis(timeout))
                        .await?,
                ))
            });
        }
        loop {
            let result = tokio::select! {
                _ = ctx.cancellation.cancelled() => return Err(ToolError::ExecutionFailed("agent wait cancelled".into())),
                result = waits.next() => result,
            };
            let Some(result) = result else {
                return Ok(json!({"status":{},"timed_out":true}));
            };
            let (id, output) = result?;
            if terminal(&output) {
                ready.insert(id.clone(), output);
                return Ok(json!({"status":ready,"timed_out":false}));
            }
        }
    }
}
fn terminal(output: &Value) -> bool {
    matches!(
        output["status"].as_str(),
        Some("completed" | "failed" | "cancelled" | "interrupted")
    )
}
#[cfg(test)]
mod tests;
