//! miniQ's complete, standalone base prompt.
//! See ../prompts/README.md for provenance and verification.

use miniq_models::{ChatMessage, ChatRole};

pub(crate) const SYSTEM_PROMPT: &str = include_str!("../prompts/system-prompt.md");
const RETIRED_POLICY_HEADER: &str = "miniQ execution policy: independent work first";

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
    fn embedded_prompt_already_contains_miniq_identity_and_runtime_bindings() {
        assert!(SYSTEM_PROMPT.starts_with("You are miniQ,"));
        assert!(SYSTEM_PROMPT.contains("# Autonomy and persistence"));
        assert_eq!(SYSTEM_PROMPT.matches("<miniq_runtime_bindings>").count(), 1);
        assert!(SYSTEM_PROMPT.contains("Use shell_run for shell commands"));
        assert!(!SYSTEM_PROMPT.contains("You are Codex"));
        assert!(!SYSTEM_PROMPT.contains("an agent based on GPT-6"));
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
        let current = SYSTEM_PROMPT.to_string();
        refresh_child_context(&mut history, current.clone());
        refresh_child_context(&mut history, current.clone());
        assert_eq!(history.len(), 4);
        assert_eq!(history[0].content, current);
        assert_eq!(history[1].content, "task-specific constraints");
        assert_eq!(history[2].content, "Review all files");
        assert_eq!(history[3].content, "Complete file evidence");
    }
}
