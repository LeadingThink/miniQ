//! Agent delegation tools backed by the host runtime.

use std::time::Duration;

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRequest {
    pub prompt: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub subagent_type: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub resume: Option<String>,
    #[serde(default)]
    pub run_in_background: bool,
    #[serde(default)]
    pub max_turns: Option<usize>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub isolation: Option<String>,
}

impl AgentRunRequest {
    pub fn validate(&self) -> Result<(), ToolError> {
        if self.prompt.trim().is_empty() {
            return Err(ToolError::InvalidInput("agent prompt is empty".into()));
        }
        for (field, value) in [
            ("description", self.description.as_deref()),
            ("subagentType", self.subagent_type.as_deref()),
            ("model", self.model.as_deref()),
            ("resume", self.resume.as_deref()),
            ("name", self.name.as_deref()),
            ("cwd", self.cwd.as_deref()),
            ("isolation", self.isolation.as_deref()),
        ] {
            if value.is_some_and(|value| value.trim().is_empty()) {
                return Err(ToolError::InvalidInput(format!("{field} is empty")));
            }
        }
        if self
            .max_turns
            .is_some_and(|turns| !(1..=96).contains(&turns))
        {
            return Err(ToolError::InvalidInput(
                "maxTurns must be between 1 and 96".into(),
            ));
        }
        if self.mode.as_deref().is_some_and(|mode| {
            !matches!(
                mode,
                "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan" | "auto"
            )
        }) {
            return Err(ToolError::InvalidInput("unsupported agent mode".into()));
        }
        if self
            .isolation
            .as_deref()
            .is_some_and(|value| value != "worktree")
        {
            return Err(ToolError::InvalidInput(
                "isolation must be `worktree`".into(),
            ));
        }
        if self.cwd.is_some() && self.isolation.is_some() {
            return Err(ToolError::InvalidInput(
                "cwd and isolation cannot be used together".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMessageRequest {
    pub recipient: String,
    pub message: String,
    #[serde(default)]
    pub summary: Option<String>,
}

impl AgentMessageRequest {
    fn validate(&self) -> Result<(), ToolError> {
        if self.recipient.trim().is_empty() || self.message.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "recipient and message must not be empty".into(),
            ));
        }
        if self
            .summary
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(ToolError::InvalidInput("summary is empty".into()));
        }
        Ok(())
    }
}

#[async_trait]
pub trait AgentBridge: Send + Sync {
    async fn run(&self, request: AgentRunRequest) -> Result<Value, ToolError>;
    async fn output(&self, id: &str, block: bool, timeout: Duration) -> Result<Value, ToolError>;
    async fn stop(&self, id: &str) -> Result<Value, ToolError>;
    async fn send(&self, request: AgentMessageRequest) -> Result<Value, ToolError>;
}

pub struct AgentRunTool;

#[async_trait]
impl Tool for AgentRunTool {
    fn name(&self) -> &str {
        "agent_run"
    }

    fn description(&self) -> &str {
        "Delegate a focused task to a child agent using the current OneAPI provider. Child tool calls keep the same workspace, approval, audit, and sandbox controls."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "description": {"type": "string"},
                "subagentType": {"type": "string"},
                "model": {"type": "string"},
                "resume": {"type": "string"},
                "runInBackground": {"type": "boolean"},
                "maxTurns": {"type": "integer", "minimum": 1, "maximum": 96},
                "name": {"type": "string"},
                "mode": {"type": "string", "enum": ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan", "auto"]},
                "cwd": {"type": "string", "description": "Child working directory relative to the current workspace"},
                "isolation": {"type": "string", "enum": ["worktree"], "description": "Run the child in a dedicated Git worktree; clean worktrees are removed automatically and changed worktrees are retained"}
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        match serde_json::from_value::<AgentRunRequest>(input.clone())
            .map_err(|error| ToolError::InvalidInput(error.to_string()))
            .and_then(|request| request.validate())
        {
            Ok(()) => low_risk("delegates work through the same controlled tool executor"),
            Err(error) => blocked(&error.to_string()),
        }
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let request: AgentRunRequest = parse_input(input)?;
        request.validate()?;
        ctx.agents
            .as_ref()
            .ok_or_else(|| ToolError::ExecutionFailed("agent runtime is unavailable".into()))?
            .run(request)
            .await
    }
}

pub struct AgentMessageTool;

#[async_trait]
impl Tool for AgentMessageTool {
    fn name(&self) -> &str {
        "agent_message"
    }

    fn description(&self) -> &str {
        "Send follow-up instructions to a running or completed background agent."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "recipient": {"type": "string"},
                "message": {"type": "string"},
                "summary": {"type": "string"}
            },
            "required": ["recipient", "message"],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        match serde_json::from_value::<AgentMessageRequest>(input.clone())
            .map_err(|error| ToolError::InvalidInput(error.to_string()))
            .and_then(|request| request.validate())
        {
            Ok(()) => low_risk("sends instructions to a miniQ child agent"),
            Err(error) => blocked(&error.to_string()),
        }
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let request: AgentMessageRequest = parse_input(input)?;
        request.validate()?;
        ctx.agents
            .as_ref()
            .ok_or_else(|| ToolError::ExecutionFailed("agent runtime is unavailable".into()))?
            .send(request)
            .await
    }
}

fn low_risk(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Low,
        reason: reason.into(),
    }
}

fn blocked(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Blocked,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_isolation_schema_matches_runtime_validation() {
        let schema = AgentRunTool.parameters_schema();
        assert_eq!(
            schema["properties"]["isolation"]["enum"],
            json!(["worktree"])
        );

        let context = ToolContext::new(std::env::temp_dir());
        let invalid = AgentRunTool.evaluate_risk(
            &context,
            &json!({"prompt":"inspect","cwd":"src","isolation":"worktree"}),
        );
        assert_eq!(invalid.level, RiskLevel::Blocked);
        assert!(invalid.reason.contains("cannot be used together"));
    }
}
