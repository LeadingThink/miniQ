//! OpenCode-style prompt surface: left accent, multiline editor, metadata, footer.
use super::Status;
use crate::repl::{
    editor::{Editor, Menu},
    text,
};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
    Frame,
};

pub fn draw(
    frame: &mut Frame,
    area: Rect,
    editor: &Editor,
    status: &Status,
    lines: Vec<Line<'static>>,
    cursor: (usize, usize),
) {
    if area.width < 6 || area.height < 6 {
        return;
    }
    let shell = editor.buffer().starts_with('!');
    let accent = if shell { text::SUCCESS } else { text::ACCENT };
    let panel = Rect::new(area.x, area.y, area.width, area.height - 1);
    frame.render_widget(
        Block::default().style(Style::default().bg(text::PANEL)),
        panel,
    );
    for y in panel.y..panel.bottom() {
        let symbol = if y == panel.bottom() - 1 {
            "╹"
        } else {
            "┃"
        };
        frame.render_widget(
            Paragraph::new(symbol).style(Style::default().fg(accent)),
            Rect::new(area.x, y, 1, 1),
        );
    }
    let input = Rect::new(area.x + 3, area.y + 1, area.width - 5, area.height - 5);
    let first = cursor
        .0
        .saturating_sub(input.height.saturating_sub(1) as usize);
    if editor.is_empty() {
        let placeholder = if status.card.is_some() {
            "Type an answer…"
        } else {
            "Ask anything…"
        };
        frame.render_widget(
            Paragraph::new(placeholder).style(Style::default().fg(text::MUTED)),
            input,
        );
    } else {
        let visible: Vec<_> = lines
            .into_iter()
            .skip(first)
            .take(input.height as usize)
            .collect();
        frame.render_widget(Paragraph::new(visible), input);
    }
    let mut metadata = vec![
        Span::styled(
            if shell { "Shell  " } else { "miniQ  " },
            Style::default().fg(accent).add_modifier(Modifier::BOLD),
        ),
        Span::raw(status.model.clone()),
        Span::styled(
            format!("  {}", status.effort),
            Style::default().fg(text::MUTED),
        ),
    ];
    if !status.files.is_empty() {
        metadata.push(Span::styled(
            format!("  @{} files", status.files.len()),
            Style::default().fg(accent),
        ));
    }
    if status.queue > 0 {
        metadata.push(Span::styled(
            format!("  {} queued", status.queue),
            Style::default().fg(accent),
        ));
    }
    if let Some(mode) = editor.mode_indicator() {
        metadata.push(Span::raw(format!("  {mode}")));
    }
    frame.render_widget(
        Paragraph::new(Line::from(metadata)),
        Rect::new(input.x, area.bottom() - 3, input.width, 1),
    );
    let footer = if let Some((custom, true)) = &status.custom {
        custom.clone()
    } else if status.running {
        format!(
            "◉ {}  {}s   esc interrupt · enter queue · tab steer",
            status.phase, status.elapsed
        )
    } else if let Some((custom, false)) = &status.custom {
        format!("{}  {custom}", status.cwd)
    } else {
        status.cwd.clone()
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(text::MUTED)),
        Rect::new(area.x + 2, area.bottom() - 1, area.width - 2, 1),
    );
    frame.set_cursor_position((
        input.x + cursor.1.min(input.width.saturating_sub(1) as usize) as u16,
        input.y + (cursor.0 - first).min(input.height.saturating_sub(1) as usize) as u16,
    ));
}

pub fn completion(frame: &mut Frame, composer: Rect, menu: &Menu) {
    let count = menu
        .items
        .len()
        .min(composer.y.saturating_sub(1) as usize)
        .min(8);
    if count == 0 {
        return;
    }
    let first = menu.selected.saturating_sub(count - 1);
    let area = Rect::new(
        composer.x,
        composer.y - count as u16 - 1,
        composer.width,
        count as u16 + 1,
    );
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default().style(Style::default().bg(text::PANEL)),
        area,
    );
    for (row, (index, (command, description))) in menu
        .items
        .iter()
        .enumerate()
        .skip(first)
        .take(count)
        .enumerate()
    {
        let selected = index == menu.selected;
        let style = if selected {
            Style::default().bg(text::SELECTED).fg(text::ACCENT)
        } else {
            Style::default().fg(text::MUTED)
        };
        let line = format!(
            " {}{command}  {description}",
            if selected { "› " } else { "  " }
        );
        frame.render_widget(
            Paragraph::new(crate::output::terminal_text(&line)).style(style),
            Rect::new(
                area.x + 1,
                area.y + row as u16,
                area.width.saturating_sub(2),
                1,
            ),
        );
    }
    let footer = format!(
        " ↑↓ select   tab complete   {}/{}",
        menu.selected + 1,
        menu.items.len()
    );
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(text::MUTED)),
        Rect::new(
            area.x + 1,
            area.bottom() - 1,
            area.width.saturating_sub(2),
            1,
        ),
    );
}
