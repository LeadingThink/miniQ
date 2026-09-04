//! Adapters for provider-native tool names and argument conventions.
//!
//! Adaptation happens before risk evaluation. The returned canonical call is
//! therefore still validated, approved, dispatched and audited exactly like a
//! tool call that used miniQ's public schema directly.

mod basic;
mod names;
mod structured;

use miniq_models::ToolCallRequest;
use serde_json::{json, Map};
use thiserror::Error;

use self::basic::{
    adapt_grep, adapt_multi_edit, adapt_process_output, adapt_read, adapt_shell, remap,
};
use self::structured::{adapt_agent, adapt_mcp, adapt_questions, adapt_tasks, parse_mcp_name};
pub(super) use basic::object;

pub use names::native_aliases;

#[derive(Debug, Clone, PartialEq)]
pub struct AdaptedToolCall {
    pub call: ToolCallRequest,
    pub original_name: String,
}

#[derive(Debug, Clone, Error, PartialEq)]
#[error("{message}")]
pub struct NativeToolError {
    pub code: &'static str,
    pub requested_tool: String,
    pub message: String,
}

impl NativeToolError {
    pub(super) fn invalid(call: &ToolCallRequest, message: impl Into<String>) -> Self {
        Self {
            code: "invalid_native_tool_input",
            requested_tool: call.name.clone(),
            message: message.into(),
        }
    }

    pub(super) fn unsupported(call: &ToolCallRequest, message: impl Into<String>) -> Self {
        Self {
            code: "unsupported_native_tool_feature",
            requested_tool: call.name.clone(),
            message: message.into(),
        }
    }
}

/// Return the miniQ tool that has equivalent semantics for a provider-native
/// name. Canonical miniQ names intentionally return `None`.
pub fn canonical_name(name: &str) -> Option<&'static str> {
    match name {
        "Bash" | "bash" | "shell" | "shell_command" | "exec_command" => Some("shell_run"),
        "Read" | "read" | "read_file" => Some("file_read"),
        "Write" | "write" | "write_file" => Some("file_write"),
        "Edit" | "edit" | "edit_file" => Some("file_edit"),
        "MultiEdit" | "multi_edit" => Some("file_patch"),
        "ApplyPatch" => Some("apply_patch"),
        "NotebookEdit" => Some("notebook_edit"),
        "Glob" | "glob" | "glob_files" => Some("file_glob"),
        "Grep" | "grep" | "grep_files" => Some("file_grep"),
        "WebFetch" | "fetch_url" => Some("web_fetch"),
        "WebSearch" | "search_web" => Some("web_search"),
        "ToolSearch" => Some("tool_search"),
        "AskUserQuestion" | "ask_user_question" | "request_user_input" => Some("ask_user"),
        "TodoWrite" | "update_plan" => Some("task_update"),
        "Skill" => Some("skill_read"),
        "Task" | "Agent" => Some("agent_run"),
        "TaskOutput" => Some("process_output"),
        "KillShell" | "TaskStop" => Some("process_kill"),
        "SendMessage" => Some("agent_message"),
        "TaskCreate" => Some("task_create"),
        "TaskGet" => Some("task_get"),
        "TaskList" => Some("task_list"),
        "TaskUpdate" => Some("task_item_update"),
        "EnterPlanMode" | "ExitPlanMode" => Some("plan_mode"),
        _ if parse_mcp_name(name).is_some() => Some("mcp_call"),
        _ => None,
    }
}

pub fn adapt_native_tool_call(
    call: &ToolCallRequest,
) -> Result<Option<AdaptedToolCall>, NativeToolError> {
    let Some(mut canonical) = canonical_name(&call.name) else {
        return Ok(None);
    };
    let arguments = match canonical {
        "shell_run" => adapt_shell(call)?,
        "file_read" => {
            let (target, arguments) = adapt_read(call)?;
            canonical = target;
            arguments
        }
        "file_patch" => adapt_multi_edit(call)?,
        "apply_patch" => remap(call, &[("patch", "patch"), ("operation", "operation")], &[])?,
        "notebook_edit" => remap(
            call,
            &[
                ("notebook_path", "path"),
                ("path", "path"),
                ("cell_id", "cellId"),
                ("cellId", "cellId"),
                ("new_source", "newSource"),
                ("newSource", "newSource"),
                ("cell_type", "cellType"),
                ("cellType", "cellType"),
                ("edit_mode", "editMode"),
                ("editMode", "editMode"),
            ],
            &[],
        )?,
        "file_grep" => adapt_grep(call)?,
        "ask_user" if call.name == "AskUserQuestion" => adapt_questions(call)?,
        "task_update" => adapt_tasks(call)?,
        "mcp_call" => adapt_mcp(call)?,
        "process_output" => adapt_process_output(call)?,
        "process_kill" => remap(
            call,
            &[("shell_id", "id"), ("task_id", "id"), ("id", "id")],
            &[],
        )?,
        "file_write" => remap(
            call,
            &[
                ("file_path", "path"),
                ("path", "path"),
                ("content", "content"),
            ],
            &[],
        )?,
        "file_edit" => remap(
            call,
            &[
                ("file_path", "path"),
                ("path", "path"),
                ("old_string", "oldString"),
                ("oldString", "oldString"),
                ("new_string", "newString"),
                ("newString", "newString"),
                ("replace_all", "replaceAll"),
                ("replaceAll", "replaceAll"),
            ],
            &[],
        )?,
        "file_glob" => remap(
            call,
            &[
                ("pattern", "pattern"),
                ("path", "path"),
                ("offset", "offset"),
                ("limit", "limit"),
            ],
            &[],
        )?,
        "web_fetch" => remap(
            call,
            &[
                ("url", "url"),
                ("prompt", "prompt"),
                ("max_bytes", "maxBytes"),
                ("maxBytes", "maxBytes"),
            ],
            &[],
        )?,
        "web_search" => remap(
            call,
            &[
                ("query", "query"),
                ("max_results", "maxResults"),
                ("maxResults", "maxResults"),
                ("allowed_domains", "allowedDomains"),
                ("allowedDomains", "allowedDomains"),
                ("blocked_domains", "blockedDomains"),
                ("blockedDomains", "blockedDomains"),
                ("provider", "provider"),
            ],
            &[],
        )?,
        "tool_search" => remap(
            call,
            &[
                ("query", "query"),
                ("max_results", "limit"),
                ("maxResults", "limit"),
                ("limit", "limit"),
                ("offset", "offset"),
            ],
            &[],
        )?,
        "ask_user" => remap(
            call,
            &[
                ("prompt", "prompt"),
                ("question", "prompt"),
                ("options", "options"),
                ("default", "default"),
            ],
            &[],
        )?,
        "skill_read" => remap(
            call,
            &[("skill", "name"), ("name", "name"), ("args", "args")],
            &[],
        )?,
        "agent_run" => adapt_agent(call)?,
        "agent_message" => remap(
            call,
            &[
                ("to", "recipient"),
                ("recipient", "recipient"),
                ("message", "message"),
                ("content", "message"),
                ("summary", "summary"),
            ],
            &[],
        )?,
        "task_create" => remap(
            call,
            &[
                ("subject", "subject"),
                ("description", "description"),
                ("activeForm", "activeForm"),
                ("active_form", "activeForm"),
                ("metadata", "metadata"),
            ],
            &[],
        )?,
        "task_get" => remap(
            call,
            &[
                ("taskId", "taskId"),
                ("task_id", "taskId"),
                ("id", "taskId"),
            ],
            &[],
        )?,
        "task_list" => remap(call, &[], &[])?,
        "task_item_update" => remap(
            call,
            &[
                ("taskId", "taskId"),
                ("task_id", "taskId"),
                ("id", "taskId"),
                ("subject", "subject"),
                ("description", "description"),
                ("activeForm", "activeForm"),
                ("active_form", "activeForm"),
                ("status", "status"),
                ("owner", "owner"),
                ("addBlocks", "addBlocks"),
                ("addBlockedBy", "addBlockedBy"),
                ("metadata", "metadata"),
            ],
            &[],
        )?,
        "plan_mode" => {
            object(call)?;
            if !call.arguments.as_object().is_some_and(Map::is_empty) {
                return Err(NativeToolError::invalid(
                    call,
                    format!("{} takes no arguments", call.name),
                ));
            }
            json!({"action": if call.name == "EnterPlanMode" { "enter" } else { "exit" }})
        }
        _ => call.arguments.clone(),
    };
    Ok(Some(AdaptedToolCall {
        call: ToolCallRequest {
            id: call.id.clone(),
            name: canonical.to_string(),
            arguments,
        },
        original_name: call.name.clone(),
    }))
}

#[cfg(test)]
mod tests;
