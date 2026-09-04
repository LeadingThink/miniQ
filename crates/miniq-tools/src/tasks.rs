//! Session-scoped structured task graph compatible with Claude task tools.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRecord {
    id: String,
    subject: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_form: Option<String>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    blocked_by: BTreeSet<String>,
    blocks: BTreeSet<String>,
    metadata: Map<String, Value>,
}

#[derive(Default)]
struct TaskBoard {
    next_id: u64,
    tasks: BTreeMap<String, TaskRecord>,
}

#[derive(Default)]
pub struct TaskManager {
    boards: Mutex<HashMap<String, TaskBoard>>,
}

impl TaskManager {
    fn create(&self, scope: &str, input: TaskCreateInput) -> Value {
        let mut boards = self.boards.lock().expect("task boards mutex poisoned");
        let board = boards.entry(scope.to_string()).or_default();
        board.next_id += 1;
        let id = board.next_id.to_string();
        let record = TaskRecord {
            id: id.clone(),
            subject: input.subject,
            description: input.description,
            active_form: input.active_form,
            status: "pending".into(),
            owner: None,
            blocked_by: BTreeSet::new(),
            blocks: BTreeSet::new(),
            metadata: input.metadata,
        };
        board.tasks.insert(id, record.clone());
        board_output(board, Some(record))
    }

    fn get(&self, scope: &str, id: &str) -> Result<Value, ToolError> {
        let boards = self.boards.lock().expect("task boards mutex poisoned");
        let board = boards.get(scope).ok_or_else(|| unknown_task(id))?;
        let task = board
            .tasks
            .get(id)
            .cloned()
            .ok_or_else(|| unknown_task(id))?;
        Ok(board_output(board, Some(task)))
    }

    fn list(&self, scope: &str) -> Value {
        let boards = self.boards.lock().expect("task boards mutex poisoned");
        match boards.get(scope) {
            Some(board) => board_output(board, None),
            None => json!({"tasks": []}),
        }
    }

    fn update(&self, scope: &str, input: TaskItemUpdateInput) -> Result<Value, ToolError> {
        let mut boards = self.boards.lock().expect("task boards mutex poisoned");
        let board = boards
            .get_mut(scope)
            .ok_or_else(|| unknown_task(&input.task_id))?;
        ensure_related_tasks_exist(board, &input)?;
        if input.status.as_deref() == Some("deleted") {
            let removed = board
                .tasks
                .remove(&input.task_id)
                .ok_or_else(|| unknown_task(&input.task_id))?;
            for task in board.tasks.values_mut() {
                task.blocked_by.remove(&input.task_id);
                task.blocks.remove(&input.task_id);
            }
            return Ok(json!({"deletedTask": removed, "tasks": task_values(board)}));
        }
        apply_relationships(
            board,
            &input.task_id,
            &input.add_blocks,
            &input.add_blocked_by,
        );
        let task = board
            .tasks
            .get_mut(&input.task_id)
            .ok_or_else(|| unknown_task(&input.task_id))?;
        if let Some(subject) = input.subject {
            task.subject = subject;
        }
        if let Some(description) = input.description {
            task.description = description;
        }
        if let Some(active_form) = input.active_form {
            task.active_form = Some(active_form);
        }
        if let Some(status) = input.status {
            task.status = status;
        }
        if let Some(owner) = input.owner {
            task.owner = Some(owner);
        }
        if let Some(metadata) = input.metadata {
            task.metadata.extend(metadata);
        }
        let task = task.clone();
        Ok(board_output(board, Some(task)))
    }
}

fn ensure_related_tasks_exist(
    board: &TaskBoard,
    input: &TaskItemUpdateInput,
) -> Result<(), ToolError> {
    if !board.tasks.contains_key(&input.task_id) {
        return Err(unknown_task(&input.task_id));
    }
    for id in input.add_blocks.iter().chain(&input.add_blocked_by) {
        if id == &input.task_id {
            return Err(ToolError::InvalidInput("a task cannot block itself".into()));
        }
        if !board.tasks.contains_key(id) {
            return Err(unknown_task(id));
        }
    }
    Ok(())
}

fn apply_relationships(
    board: &mut TaskBoard,
    task_id: &str,
    blocks: &[String],
    blocked_by: &[String],
) {
    for id in blocks {
        board
            .tasks
            .get_mut(task_id)
            .unwrap()
            .blocks
            .insert(id.clone());
        board
            .tasks
            .get_mut(id)
            .unwrap()
            .blocked_by
            .insert(task_id.to_string());
    }
    for id in blocked_by {
        board
            .tasks
            .get_mut(task_id)
            .unwrap()
            .blocked_by
            .insert(id.clone());
        board
            .tasks
            .get_mut(id)
            .unwrap()
            .blocks
            .insert(task_id.to_string());
    }
}

fn board_output(board: &TaskBoard, task: Option<TaskRecord>) -> Value {
    match task {
        Some(task) => json!({"task": task, "tasks": task_values(board)}),
        None => json!({"tasks": task_values(board)}),
    }
}

fn task_values(board: &TaskBoard) -> Vec<TaskRecord> {
    board.tasks.values().cloned().collect()
}

fn unknown_task(id: &str) -> ToolError {
    ToolError::InvalidInput(format!("unknown task: {id}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskCreateInput {
    subject: String,
    description: String,
    #[serde(default)]
    active_form: Option<String>,
    #[serde(default)]
    metadata: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskIdInput {
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskItemUpdateInput {
    task_id: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    active_form: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    add_blocks: Vec<String>,
    #[serde(default)]
    add_blocked_by: Vec<String>,
    #[serde(default)]
    metadata: Option<Map<String, Value>>,
}

fn validate_non_empty(field: &str, value: &str) -> Result<(), ToolError> {
    if value.trim().is_empty() {
        return Err(ToolError::InvalidInput(format!("{field} is empty")));
    }
    Ok(())
}

fn validate_update(input: &TaskItemUpdateInput) -> Result<(), ToolError> {
    validate_non_empty("taskId", &input.task_id)?;
    if input.subject.is_none()
        && input.description.is_none()
        && input.active_form.is_none()
        && input.status.is_none()
        && input.owner.is_none()
        && input.add_blocks.is_empty()
        && input.add_blocked_by.is_empty()
        && input.metadata.is_none()
    {
        return Err(ToolError::InvalidInput("task update has no changes".into()));
    }
    for (field, value) in [
        ("subject", input.subject.as_deref()),
        ("description", input.description.as_deref()),
        ("activeForm", input.active_form.as_deref()),
        ("owner", input.owner.as_deref()),
    ] {
        if let Some(value) = value {
            validate_non_empty(field, value)?;
        }
    }
    if input.status.as_deref().is_some_and(|status| {
        !matches!(status, "pending" | "in_progress" | "completed" | "deleted")
    }) {
        return Err(ToolError::InvalidInput("invalid task status".into()));
    }
    Ok(())
}

pub struct TaskCreateTool;
pub struct TaskGetTool;
pub struct TaskListTool;
pub struct TaskItemUpdateTool;

#[async_trait]
impl Tool for TaskCreateTool {
    fn name(&self) -> &str {
        "task_create"
    }
    fn description(&self) -> &str {
        "Create one structured task in the current session task graph."
    }
    fn parameters_schema(&self) -> Value {
        create_schema()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk()
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: TaskCreateInput = parse_input(input)?;
        validate_non_empty("subject", &input.subject)?;
        validate_non_empty("description", &input.description)?;
        if let Some(value) = input.active_form.as_deref() {
            validate_non_empty("activeForm", value)?;
        }
        Ok(ctx.tasks.create(&ctx.task_scope, input))
    }
}

#[async_trait]
impl Tool for TaskGetTool {
    fn name(&self) -> &str {
        "task_get"
    }
    fn description(&self) -> &str {
        "Get one structured task and the current task graph."
    }
    fn parameters_schema(&self) -> Value {
        task_id_schema()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk()
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: TaskIdInput = parse_input(input)?;
        validate_non_empty("taskId", &input.task_id)?;
        ctx.tasks.get(&ctx.task_scope, &input.task_id)
    }
}

#[async_trait]
impl Tool for TaskListTool {
    fn name(&self) -> &str {
        "task_list"
    }
    fn description(&self) -> &str {
        "List the current session's complete structured task graph."
    }
    fn parameters_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk()
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let object = input
            .as_object()
            .ok_or_else(|| ToolError::InvalidInput("input must be an object".into()))?;
        if !object.is_empty() {
            return Err(ToolError::InvalidInput(
                "task_list takes no arguments".into(),
            ));
        }
        Ok(ctx.tasks.list(&ctx.task_scope))
    }
}

#[async_trait]
impl Tool for TaskItemUpdateTool {
    fn name(&self) -> &str {
        "task_item_update"
    }
    fn description(&self) -> &str {
        "Update, assign, link, complete, or delete one structured task."
    }
    fn parameters_schema(&self) -> Value {
        update_schema()
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        low_risk()
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: TaskItemUpdateInput = parse_input(input)?;
        validate_update(&input)?;
        ctx.tasks.update(&ctx.task_scope, input)
    }
}

fn create_schema() -> Value {
    json!({
        "type":"object",
        "properties":{
            "subject":{"type":"string"}, "description":{"type":"string"},
            "activeForm":{"type":"string"}, "metadata":{"type":"object"}
        },
        "required":["subject","description"], "additionalProperties":false
    })
}

fn task_id_schema() -> Value {
    json!({"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"],"additionalProperties":false})
}

fn update_schema() -> Value {
    json!({
        "type":"object",
        "properties":{
            "taskId":{"type":"string"}, "subject":{"type":"string"},
            "description":{"type":"string"}, "activeForm":{"type":"string"},
            "status":{"type":"string","enum":["pending","in_progress","completed","deleted"]},
            "owner":{"type":"string"}, "addBlocks":{"type":"array","items":{"type":"string"}},
            "addBlockedBy":{"type":"array","items":{"type":"string"}}, "metadata":{"type":"object"}
        },
        "required":["taskId"], "additionalProperties":false
    })
}

fn low_risk() -> Risk {
    Risk {
        level: RiskLevel::Low,
        reason: "updates in-memory session task state".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_links_updates_and_deletes_tasks() {
        let context = ToolContext::new(std::path::PathBuf::from("."));
        let first = TaskCreateTool
            .execute(
                &context,
                json!({"subject":"First","description":"Do first"}),
            )
            .await
            .unwrap();
        let second = TaskCreateTool
            .execute(
                &context,
                json!({"subject":"Second","description":"Do second"}),
            )
            .await
            .unwrap();
        let first_id = first["task"]["id"].as_str().unwrap();
        let second_id = second["task"]["id"].as_str().unwrap();

        let linked = TaskItemUpdateTool
            .execute(
                &context,
                json!({"taskId": second_id, "status":"in_progress", "addBlockedBy":[first_id]}),
            )
            .await
            .unwrap();
        assert_eq!(linked["task"]["blockedBy"], json!([first_id]));
        assert_eq!(linked["tasks"][0]["blocks"], json!([second_id]));

        let deleted = TaskItemUpdateTool
            .execute(&context, json!({"taskId": first_id, "status":"deleted"}))
            .await
            .unwrap();
        assert_eq!(deleted["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(deleted["tasks"][0]["blockedBy"], json!([]));
    }
}
