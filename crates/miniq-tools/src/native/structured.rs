use miniq_models::ToolCallRequest;
use serde_json::{json, Map, Value};

use super::{object, NativeToolError};

pub(super) fn adapt_questions(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let input = object(call)?;
    if input.keys().any(|key| key != "questions") {
        return Err(NativeToolError::invalid(
            call,
            "AskUserQuestion accepts only the questions array",
        ));
    }
    let questions = input
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| NativeToolError::invalid(call, "questions must be an array"))?;
    let mut normalized = Vec::with_capacity(questions.len());
    for value in questions {
        normalized.push(adapt_question(call, value)?);
    }
    if normalized.is_empty() {
        return Err(NativeToolError::invalid(
            call,
            "questions must not be empty",
        ));
    }
    Ok(json!({"questions": normalized}))
}

fn adapt_question(call: &ToolCallRequest, value: &Value) -> Result<Value, NativeToolError> {
    let question = value
        .as_object()
        .ok_or_else(|| NativeToolError::invalid(call, "each question must be an object"))?;
    if question.keys().any(|key| {
        !matches!(
            key.as_str(),
            "question" | "header" | "options" | "multiSelect"
        )
    }) {
        return Err(NativeToolError::invalid(
            call,
            "question contains an unsupported field",
        ));
    }
    let prompt = question
        .get("question")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| NativeToolError::invalid(call, "question text must not be empty"))?;
    let mut options = Vec::new();
    let mut descriptions = Map::new();
    for option in question
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let option = option
            .as_object()
            .ok_or_else(|| NativeToolError::invalid(call, "question options must be objects"))?;
        if option
            .keys()
            .any(|key| !matches!(key.as_str(), "label" | "description"))
        {
            return Err(NativeToolError::invalid(
                call,
                "question option contains an unsupported field",
            ));
        }
        let label = option
            .get("label")
            .and_then(Value::as_str)
            .ok_or_else(|| NativeToolError::invalid(call, "question option label is required"))?;
        options.push(Value::String(label.to_string()));
        if let Some(description) = option.get("description").and_then(Value::as_str) {
            descriptions.insert(label.to_string(), Value::String(description.to_string()));
        }
    }
    Ok(json!({
        "prompt": prompt,
        "header": question.get("header").cloned().unwrap_or(Value::Null),
        "options": options,
        "optionDescriptions": descriptions,
        "multiSelect": question.get("multiSelect").cloned().unwrap_or(json!(false)),
    }))
}

pub(super) fn adapt_tasks(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let input = object(call)?;
    let source = if call.name == "TodoWrite" {
        "todos"
    } else {
        "plan"
    };
    if input.keys().any(|key| key != source) {
        return Err(NativeToolError::invalid(
            call,
            format!("{} accepts only `{source}`", call.name),
        ));
    }
    let tasks = input
        .get(source)
        .and_then(Value::as_array)
        .ok_or_else(|| NativeToolError::invalid(call, format!("{source} must be an array")))?;
    let mut normalized = Vec::with_capacity(tasks.len());
    for task in tasks {
        let task = task
            .as_object()
            .ok_or_else(|| NativeToolError::invalid(call, "each task must be an object"))?;
        let content_key = if call.name == "TodoWrite" {
            "content"
        } else {
            "step"
        };
        let content = task
            .get(content_key)
            .and_then(Value::as_str)
            .ok_or_else(|| NativeToolError::invalid(call, "task content is required"))?;
        let status = task
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| NativeToolError::invalid(call, "task status is required"))?;
        normalized.push(json!({"content": content, "status": status}));
    }
    Ok(json!({"tasks": normalized}))
}

pub(super) fn parse_mcp_name(name: &str) -> Option<(&str, &str)> {
    let value = name.strip_prefix("mcp__")?;
    let (server, tool) = value.split_once("__")?;
    (!server.is_empty() && !tool.is_empty()).then_some((server, tool))
}

pub(super) fn adapt_mcp(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let (server, tool) = parse_mcp_name(&call.name)
        .ok_or_else(|| NativeToolError::invalid(call, "invalid native MCP tool name"))?;
    object(call)?;
    Ok(json!({"server": server, "tool": tool, "arguments": call.arguments}))
}

pub(super) fn adapt_agent(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let input = object(call)?;
    let allowed = [
        "prompt",
        "description",
        "subagent_type",
        "type",
        "model",
        "resume",
        "run_in_background",
        "max_turns",
        "name",
        "mode",
        "cwd",
        "isolation",
    ];
    if let Some(key) = input.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(NativeToolError::invalid(
            call,
            format!("unsupported argument `{key}` for {}", call.name),
        ));
    }
    let prompt = input
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| NativeToolError::invalid(call, "agent prompt must not be empty"))?;
    let mut output = Map::new();
    output.insert("prompt".into(), json!(prompt));
    copy_field(input, &mut output, "description", "description");
    copy_aliases(
        call,
        input,
        &mut output,
        &["subagent_type", "type"],
        "subagentType",
    )?;
    copy_field(input, &mut output, "model", "model");
    copy_field(input, &mut output, "resume", "resume");
    copy_field(input, &mut output, "run_in_background", "runInBackground");
    copy_field(input, &mut output, "max_turns", "maxTurns");
    copy_field(input, &mut output, "name", "name");
    copy_field(input, &mut output, "mode", "mode");
    copy_field(input, &mut output, "cwd", "cwd");
    copy_field(input, &mut output, "isolation", "isolation");
    Ok(Value::Object(output))
}

fn copy_field(input: &Map<String, Value>, output: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = input.get(from) {
        output.insert(to.into(), value.clone());
    }
}

fn copy_aliases(
    call: &ToolCallRequest,
    input: &Map<String, Value>,
    output: &mut Map<String, Value>,
    aliases: &[&str],
    destination: &str,
) -> Result<(), NativeToolError> {
    for alias in aliases {
        let Some(value) = input.get(*alias) else {
            continue;
        };
        if output
            .get(destination)
            .is_some_and(|existing| existing != value)
        {
            return Err(NativeToolError::invalid(
                call,
                format!("conflicting values for `{destination}`"),
            ));
        }
        output.insert(destination.into(), value.clone());
    }
    Ok(())
}
