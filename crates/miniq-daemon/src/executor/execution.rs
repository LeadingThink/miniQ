//! Independent built-in tools run in parallel. Stateful calls remain barriers.

use miniq_agent::ToolExecutionMode;
use miniq_tools::ToolOrigin;
use serde_json::Value;

pub(super) fn mode(name: &str, arguments: &Value, origin: Option<ToolOrigin>) -> ToolExecutionMode {
    if !matches!(origin, Some(ToolOrigin::Builtin)) {
        return ToolExecutionMode::Sequential;
    }
    match name {
        // These calls share mutable files, session state, process cursors, or UI targets.
        "file_write"
        | "file_edit"
        | "file_patch"
        | "apply_patch"
        | "notebook_edit"
        | "doc_write"
        | "memory_write"
        | "memory_forget"
        | "scheduled_task_memory_write"
        | "task_update"
        | "task_create"
        | "task_item_update"
        | "plan_mode"
        | "ask_user"
        | "browser_automation"
        | "app_automation"
        | "computer_use"
        | "process_output"
        | "process_input"
        | "process_resize"
        | "process_kill"
        | "agent_message"
        | "mcp_call" => ToolExecutionMode::Sequential,
        "http_request"
            if !matches!(
                arguments.get("method").and_then(Value::as_str),
                None | Some("GET" | "HEAD" | "OPTIONS")
            ) =>
        {
            ToolExecutionMode::Sequential
        }
        _ => ToolExecutionMode::Parallel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builtins_default_to_parallel_but_extensions_do_not() {
        for name in [
            "shell_run",
            "shell_batch",
            "web_search",
            "web_fetch",
            "agent_run",
        ] {
            assert_eq!(
                mode(name, &json!({}), Some(ToolOrigin::Builtin)),
                ToolExecutionMode::Parallel
            );
        }
        assert_eq!(
            mode("unknown", &json!({}), None),
            ToolExecutionMode::Sequential
        );
        assert_eq!(
            mode(
                "extension",
                &json!({}),
                Some(ToolOrigin::Plugin {
                    id: "fixture".into(),
                    runtime: "node".into(),
                    version: "1".into(),
                })
            ),
            ToolExecutionMode::Sequential
        );
    }

    #[test]
    fn writes_and_shared_targets_remain_barriers() {
        for name in [
            "file_write",
            "file_edit",
            "task_update",
            "browser_automation",
            "ask_user",
            "process_output",
            "mcp_call",
        ] {
            assert_eq!(
                mode(name, &json!({}), Some(ToolOrigin::Builtin)),
                ToolExecutionMode::Sequential
            );
        }
        for method in ["GET", "HEAD", "OPTIONS"] {
            assert_eq!(
                mode(
                    "http_request",
                    &json!({"method":method}),
                    Some(ToolOrigin::Builtin)
                ),
                ToolExecutionMode::Parallel
            );
        }
        for method in ["POST", "PUT", "PATCH", "DELETE"] {
            assert_eq!(
                mode(
                    "http_request",
                    &json!({"method":method}),
                    Some(ToolOrigin::Builtin)
                ),
                ToolExecutionMode::Sequential
            );
        }
    }
}
