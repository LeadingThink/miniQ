//! Readable history pages retain complete message/tool data and their cursor.

use serde_json::Value;

use crate::output::terminal_text;

pub fn render_history(page: &Value) -> String {
    let mut rows = Vec::new();
    for message in page["messages"].as_array().into_iter().flatten() {
        let at = message["createdAt"].as_str().unwrap_or("");
        let id = message["id"].as_str().unwrap_or("");
        let role = message["role"].as_str().unwrap_or("message");
        let mut text = format!("{role} · {id} · {at}\n");
        text.push_str(message["content"].as_str().unwrap_or(""));
        text.push('\n');
        // Keep timing, attachment paths, agent metadata and future fields.
        let mut extra = message.clone();
        if let Some(extra) = extra.as_object_mut() {
            for key in ["id", "role", "createdAt", "content"] {
                extra.remove(key);
            }
            if !extra.is_empty() {
                text.push_str(&serde_json::to_string_pretty(extra).unwrap());
                text.push('\n');
            }
        }
        rows.push((at.to_owned(), id.to_owned(), text));
    }
    for tool in page["toolCalls"].as_array().into_iter().flatten() {
        let at = tool["createdAt"].as_str().unwrap_or("");
        let id = tool["id"].as_str().unwrap_or("");
        let name = tool["toolName"].as_str().unwrap_or("tool");
        let status = tool["status"].as_str().unwrap_or("");
        let text = format!(
            "tool {name} [{status}] · {id} · {at}\n{}\n",
            serde_json::to_string_pretty(tool).unwrap()
        );
        rows.push((at.to_owned(), id.to_owned(), text));
    }
    rows.sort_by(|left, right| (&left.0, &left.1).cmp(&(&right.0, &right.1)));
    let mut result = String::new();
    for (_, _, text) in rows {
        result.push_str(&text);
        result.push('\n');
    }
    let mut metadata = page.clone();
    if let Some(metadata) = metadata.as_object_mut() {
        metadata.remove("messages");
        metadata.remove("toolCalls");
        if !metadata.is_empty() {
            result.push_str(&serde_json::to_string_pretty(metadata).unwrap());
            result.push('\n');
        }
    }
    if result.is_empty() {
        result.push_str("No history records in this page.\n");
    }
    if !page["nextCursor"].is_null() {
        result.push_str("Continue with --before '");
        result.push_str(&page["nextCursor"].to_string());
        result.push_str("'\n");
    }
    terminal_text(&result)
}
