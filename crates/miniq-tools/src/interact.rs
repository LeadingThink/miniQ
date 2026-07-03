//! Interaction tools: task_update (plan display) and ask_user (clarifying
//! questions). Both are low risk; ask_user's actual waiting is implemented
//! by the daemon executor, which intercepts the call — the fallback here
//! only fires outside an interactive session.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

fn low_risk(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Low,
        reason: reason.to_string(),
    }
}

// ---- task_update ----

pub struct TaskUpdateTool;

#[derive(Deserialize)]
struct TaskUpdateInput {
    tasks: Vec<TaskItem>,
}

#[derive(Deserialize)]
struct TaskItem {
    content: String,
    status: String,
}

#[async_trait]
impl Tool for TaskUpdateTool {
    fn name(&self) -> &str {
        "task_update"
    }
    fn description(&self) -> &str {
        "Publish or update your step plan for the current task so the user can follow \
         progress. Call it when starting a multi-step task and whenever a step's \
         status changes."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string"},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
                        },
                        "required": ["content", "status"]
                    }
                }
            },
            "required": ["tasks"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk("plan display update")
    }
    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: TaskUpdateInput = parse_input(input)?;
        for task in &p.tasks {
            if !matches!(task.status.as_str(), "pending" | "in_progress" | "completed") {
                return Err(ToolError::InvalidInput(format!(
                    "invalid status: {}",
                    task.status
                )));
            }
            if task.content.trim().is_empty() {
                return Err(ToolError::InvalidInput("task content is empty".into()));
            }
        }
        Ok(json!({ "ok": true, "count": p.tasks.len() }))
    }
}

// ---- ask_user ----

pub struct AskUserTool;

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }
    fn description(&self) -> &str {
        "Ask the user a clarifying question and wait for their answer. Use when the \
         task is ambiguous and the wrong guess would waste work. Provide short \
         suggested options when possible."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "The question to ask"},
                "options": {"type": "array", "items": {"type": "string"}, "description": "Suggested answers (the user can also type freely)"}
            },
            "required": ["prompt"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk("asks the user a question")
    }
    async fn execute(&self, _ctx: &ToolContext, _input: Value) -> Result<Value, ToolError> {
        // The daemon executor intercepts ask_user and waits for the user;
        // reaching this fallback means there is no interactive session.
        Err(ToolError::ExecutionFailed(
            "ask_user requires an interactive session".into(),
        ))
    }
}
