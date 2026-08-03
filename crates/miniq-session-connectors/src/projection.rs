use miniq_protocol::{ExternalProvider, Role};
use serde_json::{Map, Value};

use crate::common::content_text;

const CODEX_IDE_CONTEXT_PREFIX: &str = "# Context from my IDE setup:";
const CODEX_REQUEST_MARKER: &str = "my request for codex";

pub(crate) struct ProjectedMessage {
    pub(crate) role: Role,
    pub(crate) content: String,
}

pub(crate) fn project_claude_message(
    outer_role: Role,
    content: &Value,
) -> Option<ProjectedMessage> {
    let role = claude_message_role(outer_role, content);
    let content = claude_content_text(content);
    projected_content(ExternalProvider::ClaudeCode, role, content)
        .map(|content| ProjectedMessage { role, content })
}

pub(crate) fn projected_content(
    provider: ExternalProvider,
    role: Role,
    content: String,
) -> Option<String> {
    if content.is_empty() || role == Role::System {
        return None;
    }
    if role != Role::User {
        return Some(content);
    }
    match provider {
        ExternalProvider::Codex => project_codex_user_content(content),
        ExternalProvider::ClaudeCode => project_claude_user_content(content),
        ExternalProvider::OpenCode => Some(content),
    }
}

fn project_codex_user_content(content: String) -> Option<String> {
    let leading_trimmed = content.trim_start();
    if leading_trimmed.starts_with("# AGENTS.md")
        || leading_trimmed.starts_with("<environment_context>")
    {
        return None;
    }
    if leading_trimmed.starts_with(CODEX_IDE_CONTEXT_PREFIX) {
        return extract_codex_ide_request(leading_trimmed);
    }
    Some(content)
}

fn project_claude_user_content(content: String) -> Option<String> {
    let leading_trimmed = content.trim_start();
    if leading_trimmed.contains("<local-command-caveat>")
        || leading_trimmed.starts_with("<command-name>")
    {
        return None;
    }
    Some(content)
}

fn claude_message_role(outer_role: Role, content: &Value) -> Role {
    let Value::Array(blocks) = content else {
        return outer_role;
    };
    if !blocks.is_empty() && blocks.iter().all(is_tool_result) {
        Role::Tool
    } else {
        outer_role
    }
}

fn is_tool_result(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("tool_result")
}

fn claude_content_text(value: &Value) -> String {
    let Value::Array(blocks) = value else {
        return claude_block_text(value);
    };
    blocks
        .iter()
        .map(claude_block_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn claude_block_text(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return content_text(value);
    };
    match object.get("type").and_then(Value::as_str) {
        Some("tool_use" | "function_call") => tool_marker(object),
        Some("tool_result") => tool_result_text(object),
        _ => content_text(value),
    }
}

fn tool_marker(object: &Map<String, Value>) -> String {
    tool_name(object)
        .map(|name| format!("[Tool: {name}]"))
        .unwrap_or_else(|| "[Tool]".to_owned())
}

fn tool_name(object: &Map<String, Value>) -> Option<&str> {
    object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            object
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
        })
}

fn tool_result_text(object: &Map<String, Value>) -> String {
    let content = object
        .get("content")
        .map(claude_content_text)
        .or_else(|| {
            object
                .get("text")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    if content.is_empty() {
        "[Tool Result]".to_owned()
    } else {
        content
    }
}

fn extract_codex_ide_request(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut prompt = None;
    let mut following = Vec::new();
    let mut collect_following = false;
    for line in normalized.lines() {
        if let Some(inline) = codex_request_heading(line) {
            following.clear();
            match inline {
                Some(value) => {
                    prompt = Some(value.to_owned());
                    collect_following = false;
                }
                None => {
                    prompt = None;
                    collect_following = true;
                }
            }
        } else if collect_following {
            following.push(line);
        }
    }
    if let Some(prompt) = prompt {
        return (!prompt.trim().is_empty()).then(|| prompt.trim().to_owned());
    }
    let prompt = following.join("\n");
    (!prompt.trim().is_empty()).then(|| prompt.trim().to_owned())
}

fn codex_request_heading(line: &str) -> Option<Option<&str>> {
    let heading = line
        .trim()
        .strip_prefix('#')?
        .trim_start_matches('#')
        .trim_start();
    if !heading
        .to_ascii_lowercase()
        .starts_with(CODEX_REQUEST_MARKER)
    {
        return None;
    }
    let suffix = heading.get(CODEX_REQUEST_MARKER.len()..)?.trim_start();
    if suffix.is_empty() {
        return Some(None);
    }
    let separator = suffix.chars().next()?;
    if !matches!(separator, ':' | '：' | '-' | '—') {
        return None;
    }
    let payload = suffix
        .trim_start_matches([':', '：', '-', '—', ' ', '\t'])
        .trim();
    if payload.is_empty() {
        Some(None)
    } else {
        Some(Some(payload))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn extracts_request_from_codex_ide_context() {
        let content = concat!(
            "# Context from my IDE setup:\n\n",
            "## Open tabs:\n- app.rs\n\n",
            "## My request for Codex:\nKeep the complete prompt\nacross lines",
        );
        assert_eq!(
            projected_content(ExternalProvider::Codex, Role::User, content.to_owned()),
            Some("Keep the complete prompt\nacross lines".to_owned())
        );
    }

    #[test]
    fn projects_pure_claude_tool_results_with_tool_role() {
        let content = json!([
            {"type": "tool_result", "tool_use_id": "tool-1", "content": "first"},
            {
                "type": "tool_result",
                "tool_use_id": "tool-2",
                "content": [{"type": "text", "text": "second"}]
            }
        ]);

        let projected = project_claude_message(Role::User, &content).unwrap();

        assert_eq!(projected.role, Role::Tool);
        assert_eq!(projected.content, "first\nsecond");
    }

    #[test]
    fn preserves_claude_mixed_block_order_and_tool_names() {
        let content = json!([
            {"type": "text", "text": "before"},
            {"type": "tool_use", "name": "Bash", "input": {"command": "echo complete"}},
            {"type": "text", "text": "middle"},
            {"type": "function_call", "function": {"name": "SearchIndex"}},
            {"type": "text", "text": "after"}
        ]);

        let projected = project_claude_message(Role::Assistant, &content).unwrap();

        assert_eq!(projected.role, Role::Assistant);
        assert_eq!(
            projected.content,
            "before\n[Tool: Bash]\nmiddle\n[Tool: SearchIndex]\nafter"
        );
    }

    #[test]
    fn excludes_external_system_messages_from_projection() {
        assert_eq!(
            projected_content(
                ExternalProvider::OpenCode,
                Role::System,
                "provider instructions".to_owned(),
            ),
            None
        );
    }
}
