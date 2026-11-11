//! PI's upstream prompt, with runtime tool bindings and working directory.
//! See ../prompts/pi/README.md for provenance and generation.

use std::path::Path;

use miniq_models::{ChatMessage, ChatRole, ToolSpec};

const TEMPLATE: &str = include_str!("../prompts/pi/system-prompt.txt");
const TOOL_SLOT: &str = "- __MINIQ_TOOL_NAME__: __MINIQ_TOOL_DESCRIPTION__";
const CORE_TOOLS: [&str; 4] = ["file_read", "shell_run", "file_edit", "file_write"];
const RETIRED_POLICY_HEADER: &str = "miniQ execution policy: independent work first";

pub(crate) fn build(workspace: &Path, tools: &[ToolSpec]) -> String {
    let lines = CORE_TOOLS
        .iter()
        .filter_map(|name| tools.iter().find(|tool| tool.name == *name))
        .map(|tool| format!("- {}: {}", tool.name, tool.description))
        .collect::<Vec<_>>()
        .join("\n");
    TEMPLATE
        .replacen(
            TOOL_SLOT,
            if lines.is_empty() { "(none)" } else { &lines },
            1,
        )
        .replacen(
            "__MINIQ_CWD__",
            &workspace.to_string_lossy().replace('\\', "/"),
            1,
        )
}

/// A resumed child receives the current prompt without losing its task evidence.
pub(crate) fn refresh_child_context(history: &mut Vec<ChatMessage>, current: String) {
    history.retain(|message| {
        message.role != ChatRole::System || !message.content.starts_with(RETIRED_POLICY_HEADER)
    });
    match history.first_mut() {
        Some(message) if message.role == ChatRole::System => message.content = current,
        _ => history.insert(0, ChatMessage::system(current)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_bindings_keep_miniq_wording_and_normalize_only_the_directory() {
        let tools = vec![ToolSpec {
            name: "file_read".into(),
            description: "Read files".into(),
            parameters: serde_json::json!({"type":"object"}),
        }];
        let prompt = build(Path::new("D:\\a $& directory\\project"), &tools);
        assert!(prompt.starts_with("You are a coding assistant running inside miniQ,"));
        assert!(prompt.contains(
            "<tools>\n- file_read: Read files\n\nAdditional tools may be available.\n</tools>"
        ));
        assert!(prompt.contains("<cwd>\nD:/a $& directory/project\n</cwd>"));
        assert!(!prompt.contains("__MINIQ_"));
        assert!(!prompt.contains("Pi documentation"));
        assert!(!prompt.contains("miniQ execution policy"));
    }

    #[test]
    fn refreshing_a_child_replaces_the_prompt_and_preserves_every_result() {
        let mut history = vec![
            ChatMessage::system(RETIRED_POLICY_HEADER),
            ChatMessage::system("old runtime context"),
            ChatMessage::system("task-specific constraints"),
            ChatMessage::user("Review all files"),
            ChatMessage::tool_result("read-1", "Complete file evidence"),
        ];
        let current = build(Path::new("/workspace"), &[]);
        refresh_child_context(&mut history, current.clone());
        refresh_child_context(&mut history, current.clone());
        assert_eq!(history.len(), 4);
        assert_eq!(history[0].content, current);
        assert_eq!(history[1].content, "task-specific constraints");
        assert_eq!(history[2].content, "Review all files");
        assert_eq!(history[3].content, "Complete file evidence");
    }
}
