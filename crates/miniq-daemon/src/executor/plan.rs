use miniq_models::ToolCallRequest;
use miniq_protocol::{PlanTask, PlanTaskStatus, RiskLevel};
use serde_json::Value;

pub(super) fn plan_mode_allows(call: &ToolCallRequest, risk: RiskLevel) -> bool {
    match call.name.as_str() {
        "file_read" | "file_list" | "file_glob" | "file_grep" | "git_status" | "git_diff"
        | "doc_read" | "skill_read" | "memory_search" | "tool_search" | "web_fetch"
        | "web_search" | "ask_user" | "task_update" | "task_create" | "task_get" | "task_list"
        | "task_item_update" | "plan_mode" | "process_output" | "process_kill"
        | "agent_message" => true,
        "shell_run" | "shell_batch" => risk == RiskLevel::Low,
        "agent_run" => call.arguments.get("mode").and_then(Value::as_str) == Some("plan"),
        _ => false,
    }
}

pub(super) fn task_graph_plan(output: &Value) -> Option<Vec<PlanTask>> {
    let tasks = output.get("tasks")?.as_array()?;
    Some(
        tasks
            .iter()
            .filter_map(|task| {
                let content = task.get("subject")?.as_str()?.to_string();
                let status = match task.get("status")?.as_str()? {
                    "pending" => PlanTaskStatus::Pending,
                    "in_progress" => PlanTaskStatus::InProgress,
                    "completed" => PlanTaskStatus::Completed,
                    _ => return None,
                };
                Some(PlanTask { content, status })
            })
            .collect(),
    )
}
