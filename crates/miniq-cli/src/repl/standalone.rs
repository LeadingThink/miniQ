//! Reuse the same picker before entering chat (resume and first-run model setup).
use super::{
    picker::{Item, Outcome, Picker, Purpose},
    terminal_surface::Surface,
    text,
};
use anyhow::Result;
use crossterm::event::{self, Event, KeyEventKind, MouseButton, MouseEventKind};
use ratatui::{style::Style, widgets::Block};

pub(crate) fn choose(
    title: &str,
    choices: &[crate::selection::Choice],
    current: Option<&str>,
) -> Result<Option<String>> {
    let items = choices
        .iter()
        .map(|choice| Item::new(&choice.id, &choice.label, ""))
        .collect();
    let mut picker = Picker::new(Purpose::Commands, title, items, current.map(str::to_owned));
    let mut surface = Surface::enter()?;
    let color = super::render::Style::detect().color;
    loop {
        surface.terminal.draw(|frame| {
            frame.render_widget(
                Block::default().style(Style::default().bg(text::BACKGROUND).fg(text::TEXT)),
                frame.area(),
            );
            picker.draw(frame);
            if !color {
                for cell in &mut frame.buffer_mut().content {
                    cell.fg = ratatui::style::Color::Reset;
                    cell.bg = ratatui::style::Color::Reset;
                }
            }
        })?;
        match event::read()? {
            Event::Key(key) if key.kind != KeyEventKind::Release => match picker.key(key) {
                Outcome::Close => return Ok(None),
                Outcome::Choose(value) => return Ok(Some(value)),
                Outcome::Changed => {}
            },
            Event::Paste(value) => {
                picker.query.push_str(&crate::output::terminal_text(&value));
                picker.selected = 0;
            }
            Event::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left) => {
                if let Some(value) = picker.click(mouse.column, mouse.row) {
                    return Ok(Some(value));
                }
            }
            _ => {}
        }
    }
}
