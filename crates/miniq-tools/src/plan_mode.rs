//! Plan-mode state used by Claude-compatible enter/exit controls.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub struct PlanModeTool;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum PlanModeAction {
    Enter,
    Exit,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanModeInput {
    action: PlanModeAction,
}

#[async_trait]
impl Tool for PlanModeTool {
    fn name(&self) -> &str {
        "plan_mode"
    }

    fn description(&self) -> &str {
        "Enter or exit plan mode. While active, workspace mutations and command execution are blocked until plan mode exits."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {"action": {"type": "string", "enum": ["enter", "exit"]}},
            "required": ["action"],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        match serde_json::from_value::<PlanModeInput>(input.clone()) {
            Ok(_) => Risk {
                level: RiskLevel::Low,
                reason: "changes the current agent planning state".into(),
            },
            Err(error) => Risk {
                level: RiskLevel::Blocked,
                reason: error.to_string(),
            },
        }
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: PlanModeInput = parse_input(input)?;
        let active = matches!(input.action, PlanModeAction::Enter);
        ctx.set_plan_mode(active);
        Ok(json!({
            "mode": if active { "plan" } else { "default" },
            "writesAllowed": !active,
        }))
    }
}
