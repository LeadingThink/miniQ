//! Session context remains visible beside wide conversation layouts.
use super::Status;
use crate::repl::text;
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::Line,
    widgets::{Block, Paragraph},
    Frame,
};
use serde_json::Value;

pub fn draw(frame: &mut Frame, area: Rect, status: &Status, plan: &Value, offset: &mut usize) {
    frame.render_widget(
        Block::default().style(Style::default().bg(text::PANEL)),
        area,
    );
    let heading =
        |s: &str| Line::styled(s.to_owned(), Style::default().add_modifier(Modifier::BOLD));
    let muted = |s: String| Line::styled(s, Style::default().fg(text::MUTED));
    let mut rows = vec![
        heading("Session"),
        muted(status.title.clone()),
        Line::default(),
        heading("Context"),
        muted(
            status
                .context
                .map(|p| format!("{p:.0}% used"))
                .unwrap_or_else(|| "Calculating…".into()),
        ),
        Line::default(),
        heading("Model"),
        muted(status.model.clone()),
        muted(format!("Reasoning: {}", status.effort)),
        Line::default(),
        heading("Permissions"),
        muted(status.mode.clone()),
        Line::default(),
        heading("Workspace"),
        muted(status.cwd.clone()),
    ];
    if let Some(tasks) = plan
        .as_array()
        .or_else(|| plan["tasks"].as_array())
        .filter(|tasks| !tasks.is_empty())
    {
        rows.extend([Line::default(), heading("Todo")]);
        for task in tasks {
            let mark = match task["status"].as_str() {
                Some("completed" | "done") => "✓",
                Some("in_progress" | "running") => "◐",
                _ => "☐",
            };
            let title = task["content"]
                .as_str()
                .or(task["title"].as_str())
                .or(task["subject"].as_str())
                .unwrap_or("");
            rows.push(muted(format!(
                "{mark} {}",
                crate::output::terminal_text(title)
            )));
        }
    }
    if !status.files.is_empty() {
        rows.extend([Line::default(), heading("Attachments")]);
        rows.extend(status.files.iter().cloned().map(muted));
    }
    if status.queue > 0 {
        rows.extend([
            Line::default(),
            heading("Queue"),
            muted(format!("{} pending messages", status.queue)),
        ]);
    }
    let rows = text::wrap(&rows, area.width.saturating_sub(4) as usize);
    let height = area.height.saturating_sub(4) as usize;
    *offset = (*offset).min(rows.len().saturating_sub(height));
    let visible: Vec<_> = rows.into_iter().skip(*offset).take(height).collect();
    frame.render_widget(
        Paragraph::new(visible),
        Rect::new(
            area.x + 2,
            area.y + 2,
            area.width.saturating_sub(4),
            area.height.saturating_sub(4),
        ),
    );
    frame.render_widget(
        Paragraph::new("alt+pgup/pgdn scroll").style(Style::default().fg(text::MUTED)),
        Rect::new(
            area.x + 2,
            area.bottom().saturating_sub(1),
            area.width.saturating_sub(4),
            1,
        ),
    );
}
