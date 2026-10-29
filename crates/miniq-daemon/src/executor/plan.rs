use miniq_models::ToolCallRequest;
use miniq_protocol::{PlanTask, PlanTaskStatus, RiskLevel};
use serde_json::Value;

pub(super) fn plan_mode_allows(call: &ToolCallRequest, risk: RiskLevel) -> bool {
    match call.name.as_str() {
        "file_read"
        | "file_list"
        | "file_glob"
        | "file_grep"
        | "git_status"
        | "git_diff"
        | "doc_read"
        | "view_image"
        | "view_pdf"
        | "skill_read"
        | "memory_search"
        | "memory_read"
        | "memory_project_read"
        | "tool_search"
        | "web_fetch"
        | "web_search"
        | "ask_user"
        | "task_update"
        | "task_create"
        | "task_get"
        | "task_list"
        | "task_item_update"
        | "plan_mode"
        | "process_output"
        | "agent_wait"
        | "agent_result"
        | "process_kill"
        | "agent_message" => true,
        "process_input" => risk == RiskLevel::Low,
        "shell_run" | "shell_batch" => risk == RiskLevel::Low,
        "browser_automation" => matches!(
            call.arguments.get("action").and_then(Value::as_str),
            Some("snapshot" | "screenshot" | "status" | "tabs" | "wait" | "close")
        ),
        "computer_use" => matches!(
            call.arguments.get("action").and_then(Value::as_str),
            Some("status" | "screenshot" | "release")
        ),
        "app_automation" => matches!(
            call.arguments.get("action").and_then(Value::as_str),
            Some("status" | "windows" | "inspect" | "screenshot" | "release")
        ),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn process_input_is_not_a_plan_mode_write_bypass() {
        let call = ToolCallRequest {
            id: "input".into(),
            name: "process_input".into(),
            arguments: json!({"id":"shell_test","chars":"echo mutate\n"}),
        };
        assert!(!plan_mode_allows(&call, RiskLevel::High));
        assert!(plan_mode_allows(&call, RiskLevel::Low));
        let interactive = ToolCallRequest {
            name: "shell_run".into(),
            ..call
        };
        assert!(!plan_mode_allows(&interactive, RiskLevel::High));
    }

    #[test]
    fn plan_mode_allows_observation_but_never_desktop_input() {
        for (name, action, allowed) in [
            ("view_image", "", true),
            ("view_pdf", "", true),
            ("memory_read", "", true),
            ("memory_project_read", "", true),
            ("memory_write", "", false),
            ("memory_forget", "", false),
            ("computer_use", "screenshot", true),
            ("computer_use", "click", false),
            ("computer_use", "type", false),
            ("app_automation", "status", true),
            ("app_automation", "windows", true),
            ("app_automation", "inspect", true),
            ("app_automation", "screenshot", true),
            ("app_automation", "release", true),
            ("app_automation", "invoke", false),
            ("app_automation", "select", false),
            ("app_automation", "setValue", false),
            ("app_automation", "key", false),
            ("app_automation", "type", false),
            ("app_automation", "click", false),
            ("app_automation", "scroll", false),
            ("browser_automation", "snapshot", true),
            ("browser_automation", "type", false),
            ("browser_automation", "open", false),
        ] {
            let call = ToolCallRequest {
                id: "test".into(),
                name: name.into(),
                arguments: json!({"action":action}),
            };
            assert_eq!(plan_mode_allows(&call, RiskLevel::High), allowed);
        }
    }
}
