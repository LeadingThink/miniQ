//! Interaction tools: task_update (plan display) and ask_user (clarifying
//! questions). Both are low risk; ask_user's actual waiting is implemented
//! by the daemon executor, which intercepts the call — the fallback here
//! only fires outside an interactive session.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

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
            if !matches!(
                task.status.as_str(),
                "pending" | "in_progress" | "completed"
            ) {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AskUserInput {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    header: Option<String>,
    #[serde(default)]
    option_descriptions: HashMap<String, String>,
    #[serde(default)]
    multi_select: bool,
    #[serde(default)]
    questions: Option<Vec<AskQuestionInput>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AskQuestionInput {
    prompt: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    header: Option<String>,
    #[serde(default)]
    option_descriptions: HashMap<String, String>,
    #[serde(default)]
    multi_select: bool,
}

pub fn validate_ask_user_input(input: &Value) -> Result<(), ToolError> {
    let input: AskUserInput = parse_input(input.clone())?;
    match (input.prompt.as_deref(), input.questions.as_deref()) {
        (Some(_), Some(_)) => {
            return Err(ToolError::InvalidInput(
                "ask_user accepts prompt or questions, not both".into(),
            ))
        }
        (None, None) => {
            return Err(ToolError::InvalidInput(
                "ask_user requires prompt or questions".into(),
            ))
        }
        (Some(prompt), None) => validate_question(
            prompt,
            &input.options,
            input.default.as_deref(),
            input.header.as_deref(),
            &input.option_descriptions,
            input.multi_select,
        )?,
        (None, Some(questions)) => {
            if questions.is_empty() {
                return Err(ToolError::InvalidInput(
                    "questions must not be empty".into(),
                ));
            }
            for question in questions {
                validate_question(
                    &question.prompt,
                    &question.options,
                    question.default.as_deref(),
                    question.header.as_deref(),
                    &question.option_descriptions,
                    question.multi_select,
                )?;
            }
        }
    }
    Ok(())
}

fn validate_question(
    prompt: &str,
    options: &[String],
    default: Option<&str>,
    header: Option<&str>,
    descriptions: &HashMap<String, String>,
    multi_select: bool,
) -> Result<(), ToolError> {
    if prompt.trim().is_empty() {
        return Err(ToolError::InvalidInput("question prompt is empty".into()));
    }
    if header.is_some_and(|header| header.trim().is_empty()) {
        return Err(ToolError::InvalidInput("question header is empty".into()));
    }
    if options.iter().any(|option| option.trim().is_empty()) {
        return Err(ToolError::InvalidInput("question option is empty".into()));
    }
    if descriptions
        .keys()
        .any(|label| !options.iter().any(|option| option == label))
    {
        return Err(ToolError::InvalidInput(
            "optionDescriptions contains a label absent from options".into(),
        ));
    }
    if let Some(default) = default {
        if default.trim().is_empty() {
            return Err(ToolError::InvalidInput("question default is empty".into()));
        }
        if !multi_select && !options.is_empty() && !options.iter().any(|option| option == default) {
            return Err(ToolError::InvalidInput(
                "question default must be one of options".into(),
            ));
        }
    }
    Ok(())
}

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }
    fn description(&self) -> &str {
        "Ask one or more clarifying questions and wait for answers. Supports option \
         descriptions and multi-select questions."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "The question to ask"},
                "options": {"type": "array", "items": {"type": "string"}, "description": "Suggested answers (the user can also type freely)"},
                "default": {"type": "string", "description": "The safest reasonable answer to use if the user does not respond"},
                "header": {"type": "string", "description": "Short question heading"},
                "optionDescriptions": {"type": "object", "additionalProperties": {"type": "string"}},
                "multiSelect": {"type": "boolean"},
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "prompt": {"type": "string"},
                            "header": {"type": "string"},
                            "options": {"type": "array", "items": {"type": "string"}},
                            "optionDescriptions": {"type": "object", "additionalProperties": {"type": "string"}},
                            "multiSelect": {"type": "boolean"},
                            "default": {"type": "string"}
                        },
                        "required": ["prompt"],
                        "additionalProperties": false
                    }
                }
            },
            "oneOf": [{"required": ["prompt"]}, {"required": ["questions"]}],
            "additionalProperties": false
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk("asks the user a question")
    }
    async fn execute(&self, _ctx: &ToolContext, _input: Value) -> Result<Value, ToolError> {
        validate_ask_user_input(&_input)?;
        // The daemon executor intercepts ask_user and waits for the user;
        // reaching this fallback means there is no interactive session.
        Err(ToolError::ExecutionFailed(
            "ask_user requires an interactive session".into(),
        ))
    }
}
