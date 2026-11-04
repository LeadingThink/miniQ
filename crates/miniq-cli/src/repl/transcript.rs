//! Durable conversation rows plus one live assistant message. History pages and
//! daemon events use the same entries, so reconnects never duplicate a reply.
use super::{render, text};
use crate::output::terminal_text;
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    User,
    Assistant,
    Tool,
    Notice,
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub at: String,
    pub kind: Kind,
    pub content: String,
    pub tool: Option<Value>,
}

#[derive(Default)]
pub struct Transcript {
    pub entries: Vec<Entry>,
    pub next_cursor: Option<Value>,
    pub version: u64,
    streaming: Option<usize>,
}

impl Transcript {
    pub fn restore(&mut self, snapshot: &Value) {
        self.entries = page(snapshot);
        self.next_cursor = snapshot.get("nextCursor").filter(|v| !v.is_null()).cloned();
        self.streaming = None;
        if let Some(stream) = snapshot["streamingText"].as_str().filter(|s| !s.is_empty()) {
            self.delta(stream);
        }
        self.version += 1;
    }

    pub fn prepend(&mut self, history: &Value) {
        let mut older = page(history);
        older.retain(|entry| !self.entries.iter().any(|old| old.id == entry.id));
        if let Some(index) = self.streaming.as_mut() {
            *index += older.len();
        }
        older.append(&mut self.entries);
        self.entries = older;
        self.next_cursor = history.get("nextCursor").filter(|v| !v.is_null()).cloned();
        self.version += 1;
    }

    pub fn notice(&mut self, content: &str) {
        if content.is_empty() {
            return;
        }
        self.entries.push(Entry {
            id: String::new(),
            at: String::new(),
            kind: Kind::Notice,
            content: content.to_owned(),
            tool: None,
        });
        self.version += 1;
    }

    fn delta(&mut self, delta: &str) {
        let index = *self.streaming.get_or_insert_with(|| {
            self.entries.push(Entry {
                id: String::new(),
                at: String::new(),
                kind: Kind::Assistant,
                content: String::new(),
                tool: None,
            });
            self.entries.len() - 1
        });
        self.entries[index].content.push_str(delta);
    }

    pub fn event(&mut self, event: &Value) {
        match event["type"].as_str().unwrap_or("") {
            "assistant_delta" => self.delta(event["delta"].as_str().unwrap_or("")),
            "assistant_replaced" => {
                if let Some(index) = self.streaming.take() {
                    self.entries.remove(index);
                }
            }
            "message_created" => {
                let Some(entry) = message(&event["message"]) else {
                    return;
                };
                if entry.kind == Kind::Assistant {
                    if let Some(index) = self.streaming.take() {
                        self.entries[index] = entry;
                        self.version += 1;
                        return;
                    }
                }
                if !self
                    .entries
                    .iter()
                    .any(|e| !entry.id.is_empty() && e.id == entry.id)
                {
                    self.entries.push(entry);
                }
            }
            "tool_call_started" => {
                let mut tool = event.clone();
                tool["id"] = event["toolCallId"].clone();
                tool["status"] = Value::from("running");
                self.entries.push(tool_entry(&tool));
            }
            "tool_call_finished" => {
                if let Some(entry) = self
                    .entries
                    .iter_mut()
                    .find(|e| e.kind == Kind::Tool && e.id == event["toolCallId"])
                {
                    if let Some(tool) = entry.tool.as_mut() {
                        tool["status"] = event["status"].clone();
                        tool["output"] = event["output"].clone();
                    }
                }
            }
            "turn_completed" | "turn_failed" => self.streaming = None,
            _ => return,
        }
        self.version += 1;
    }

    pub fn lines(&self, width: usize, expanded: bool, color: bool) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        let style = render::Style { color };
        if self.next_cursor.is_some() {
            lines.push(Line::styled(
                "↑ Scroll up to load earlier messages",
                Style::default().fg(text::MUTED),
            ));
            lines.push(Line::default());
        }
        for entry in &self.entries {
            let mut body = match entry.kind {
                Kind::User => text::styled(&terminal_text(&entry.content)),
                Kind::Assistant => {
                    let mut markdown = render::Markdown::default();
                    let mut rendered = markdown.push(&entry.content, style);
                    rendered.push_str(&markdown.finish(style));
                    text::styled(rendered.trim_end_matches('\n'))
                }
                Kind::Tool => tool_lines(entry.tool.as_ref().unwrap(), expanded, style),
                Kind::Notice => text::styled(entry.content.trim_end_matches('\n')),
            };
            let inset = if entry.kind == Kind::User { 3 } else { 2 };
            body = text::wrap(&body, width.saturating_sub(inset).max(1));
            if entry.kind == Kind::User {
                lines.push(Line::styled(
                    "┃",
                    Style::default().fg(text::ACCENT).bg(text::PANEL),
                ));
            }
            for mut row in body {
                let lead = if entry.kind == Kind::User {
                    "┃  "
                } else {
                    "  "
                };
                row.spans
                    .insert(0, Span::styled(lead, Style::default().fg(text::ACCENT)));
                if entry.kind == Kind::User {
                    row.style = row.style.bg(text::PANEL);
                }
                lines.push(row);
            }
            if entry.kind == Kind::User {
                lines.push(Line::styled(
                    "╹",
                    Style::default().fg(text::ACCENT).bg(text::PANEL),
                ));
            }
            lines.push(Line::default());
        }
        lines
    }
}

fn message(value: &Value) -> Option<Entry> {
    let kind = match value["role"].as_str()? {
        "user" => Kind::User,
        "assistant" => Kind::Assistant,
        _ => return None,
    };
    let mut content = value["content"].as_str().unwrap_or("").to_owned();
    for attachment in value["attachments"].as_array().into_iter().flatten() {
        if let Some(name) = attachment["name"].as_str().or(attachment["path"].as_str()) {
            content.push_str(&format!("\n@{name}"));
        }
    }
    Some(Entry {
        id: value["id"].as_str().unwrap_or("").into(),
        at: value["createdAt"].as_str().unwrap_or("").into(),
        kind,
        content,
        tool: None,
    })
}

fn tool_entry(value: &Value) -> Entry {
    Entry {
        id: value["id"].as_str().unwrap_or("").into(),
        at: value["createdAt"].as_str().unwrap_or("").into(),
        kind: Kind::Tool,
        content: String::new(),
        tool: Some(value.clone()),
    }
}

fn page(value: &Value) -> Vec<Entry> {
    let mut entries: Vec<_> = value["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(message)
        .collect();
    entries.extend(
        value["toolCalls"]
            .as_array()
            .into_iter()
            .flatten()
            .map(tool_entry),
    );
    entries.sort_by(|a, b| (&a.at, &a.id).cmp(&(&b.at, &b.id)));
    entries
}

fn tool_lines(tool: &Value, expanded: bool, style: render::Style) -> Vec<Line<'static>> {
    let name = tool["toolName"].as_str().unwrap_or("tool");
    let status = tool["status"].as_str().unwrap_or("running");
    let icon = match status {
        "running" | "pending" => "◷",
        "failed" | "cancelled" => "×",
        _ => "✓",
    };
    let mut lines = vec![Line::styled(
        format!("{icon} {}", render::tool_summary(name, &tool["input"])),
        Style::default()
            .fg(text::MUTED)
            .add_modifier(Modifier::BOLD),
    )];
    if expanded || matches!(status, "failed" | "cancelled") {
        if tool["payloadDeferred"] == true {
            lines.push(Line::raw(
                "Payload not loaded. /tool detail SESSION_ID TOOL_CALL_ID opens it.",
            ));
        } else {
            lines.extend(text::styled(&render::tool_finished(
                status,
                tool.get("output"),
                style,
            )));
        }
    }
    lines
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
