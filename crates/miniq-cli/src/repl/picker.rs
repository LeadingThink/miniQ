//! Searchable, paged overlays; selecting an item never consumes the prompt draft.
use super::text;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::Line,
    widgets::{Block, Clear, Paragraph},
    Frame,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Purpose {
    Commands,
    Models,
    Effort,
    Sessions,
    Permissions,
}

pub struct Item {
    pub value: String,
    pub label: String,
    pub detail: String,
}
impl Item {
    pub fn new(value: &str, label: &str, detail: &str) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            detail: detail.into(),
        }
    }
}

pub struct Picker {
    pub purpose: Purpose,
    pub title: String,
    pub query: String,
    pub items: Vec<Item>,
    pub selected: usize,
    pub current: Option<String>,
    pub area: Rect,
    visible: Vec<(u16, u16, usize)>,
    detail_offset: usize,
}

pub enum Outcome {
    Changed,
    Close,
    Choose(String),
}

impl Picker {
    pub fn new(purpose: Purpose, title: &str, items: Vec<Item>, current: Option<String>) -> Self {
        let selected = current
            .as_ref()
            .and_then(|value| items.iter().position(|i| &i.value == value))
            .unwrap_or(0);
        Self {
            purpose,
            title: title.into(),
            query: String::new(),
            items,
            selected,
            current,
            area: Rect::default(),
            visible: Vec::new(),
            detail_offset: 0,
        }
    }

    pub fn matches(&self) -> Vec<usize> {
        let words: Vec<_> = self
            .query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        self.items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                let haystack =
                    format!("{} {} {}", item.value, item.label, item.detail).to_lowercase();
                words
                    .iter()
                    .all(|word| haystack.contains(word))
                    .then_some(index)
            })
            .collect()
    }

    pub fn key(&mut self, key: KeyEvent) -> Outcome {
        if key.modifiers == KeyModifiers::ALT {
            match key.code {
                KeyCode::Up => self.detail_offset = self.detail_offset.saturating_sub(1),
                KeyCode::Down => self.detail_offset = self.detail_offset.saturating_add(1),
                _ => return Outcome::Changed,
            }
            return Outcome::Changed;
        }
        self.detail_offset = 0;
        let matches = self.matches();
        let last = matches.len().saturating_sub(1);
        match (key.code, key.modifiers) {
            (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                return Outcome::Close
            }
            (KeyCode::Enter, _) => {
                if let Some(index) = matches.get(self.selected) {
                    return Outcome::Choose(self.items[*index].value.clone());
                }
            }
            (KeyCode::Up, _)
            | (KeyCode::BackTab, _)
            | (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                self.selected = self.selected.checked_sub(1).unwrap_or(last)
            }
            (KeyCode::Down | KeyCode::Tab, _) | (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                self.selected = if self.selected >= last {
                    0
                } else {
                    self.selected + 1
                }
            }
            (KeyCode::PageUp, _) => self.selected = self.selected.saturating_sub(6),
            (KeyCode::PageDown, _) => self.selected = (self.selected + 6).min(last),
            (KeyCode::Backspace, _) => {
                self.query.pop();
                self.selected = 0;
            }
            (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
                self.query.clear();
                self.selected = 0;
            }
            (KeyCode::Char(c), modifiers)
                if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.query.push(c);
                self.selected = 0;
            }
            _ => {}
        }
        Outcome::Changed
    }

    pub fn click(&self, x: u16, y: u16) -> Option<String> {
        if x < self.area.x || x >= self.area.right() {
            return None;
        }
        self.visible
            .iter()
            .find(|(start, end, _)| y >= *start && y < *end)
            .map(|(_, _, index)| self.items[*index].value.clone())
    }

    pub fn draw(&mut self, frame: &mut Frame) {
        let size = frame.area();
        let width = size.width.saturating_sub(4).min(76).max(1);
        let height = size.height.saturating_sub(4).min(24).max(1);
        let area = Rect::new(
            (size.width - width) / 2,
            (size.height - height) / 2,
            width,
            height,
        );
        self.area = area;
        frame.render_widget(Clear, area);
        frame.render_widget(
            Block::default().style(Style::default().bg(text::PANEL)),
            area,
        );
        if width < 8 || height < 8 {
            return;
        }
        let inner = Rect::new(area.x + 2, area.y + 1, width - 4, height - 2);
        frame.render_widget(
            Paragraph::new(self.title.clone()).style(Style::default().add_modifier(Modifier::BOLD)),
            Rect::new(inner.x, inner.y, inner.width.saturating_sub(5), 1),
        );
        frame.render_widget(
            Paragraph::new("esc").style(Style::default().fg(text::MUTED)),
            Rect::new(inner.right() - 3, inner.y, 3, 1),
        );
        let search = if self.query.is_empty() {
            "Type to search…".into()
        } else {
            self.query.clone()
        };
        let search_lines = text::wrap(&[Line::raw(search)], inner.width as usize);
        let search_row = search_lines.len().saturating_sub(1);
        frame.render_widget(
            Paragraph::new(search_lines[search_row].clone())
                .style(Style::default().fg(text::MUTED)),
            Rect::new(inner.x, inner.y + 2, inner.width, 1),
        );
        let matches = self.matches();
        self.selected = self.selected.min(matches.len().saturating_sub(1));
        self.visible.clear();
        let available = (height - 7) as usize;
        let rows: Vec<_> = matches
            .iter()
            .map(|index| self.item_lines(*index, inner.width as usize))
            .collect();
        let mut first = self.selected;
        let selected_height = rows.get(self.selected).map_or(0, Vec::len);
        self.detail_offset = self
            .detail_offset
            .min(selected_height.saturating_sub(available));
        let mut used = selected_height.min(available);
        while first > 0 && used + rows[first - 1].len() <= available {
            first -= 1;
            used += rows[first].len();
        }
        let mut y = inner.y + 4;
        for (position, index) in matches.iter().enumerate().skip(first) {
            if y >= area.bottom() - 2 {
                break;
            }
            let offset = if position == self.selected {
                self.detail_offset
            } else {
                0
            };
            let visible_height = rows[position]
                .len()
                .saturating_sub(offset)
                .min((area.bottom() - 2 - y) as usize) as u16;
            let style = if position == self.selected {
                Style::default().bg(text::SELECTED).fg(text::ACCENT)
            } else {
                Style::default()
            };
            let lines: Vec<_> = rows[position]
                .iter()
                .skip(offset)
                .take(visible_height as usize)
                .cloned()
                .collect();
            frame.render_widget(
                Paragraph::new(lines).style(style),
                Rect::new(inner.x, y, inner.width, visible_height),
            );
            self.visible.push((y, y + visible_height, *index));
            y += visible_height;
        }
        if matches.is_empty() {
            frame.render_widget(
                Paragraph::new("No results"),
                Rect::new(inner.x, inner.y + 4, inner.width, 1),
            );
        }
        let footer = format!(
            "↑↓ select  enter confirm  alt+↑↓ details  {}/{}",
            if matches.is_empty() {
                0
            } else {
                self.selected + 1
            },
            matches.len()
        );
        frame.render_widget(
            Paragraph::new(footer).style(Style::default().fg(text::MUTED)),
            Rect::new(inner.x, area.bottom() - 2, inner.width, 1),
        );
        let cursor = if self.query.is_empty() {
            0
        } else {
            search_lines[search_row]
                .width()
                .min(inner.width.saturating_sub(1) as usize)
        };
        frame.set_cursor_position((inner.x + cursor as u16, inner.y + 2));
    }
    fn item_lines(&self, index: usize, width: usize) -> Vec<Line<'static>> {
        let item = &self.items[index];
        let marker = if self.current.as_deref() == Some(&item.value) {
            " ●"
        } else {
            ""
        };
        let mut lines = text::wrap(
            &text::styled(&format!(
                "{}{marker}",
                crate::output::terminal_text(&item.label)
            )),
            width,
        );
        if !item.detail.is_empty() {
            let detail: Vec<_> = text::styled(&crate::output::terminal_text(&item.detail))
                .into_iter()
                .map(|line| line.style(Style::default().fg(text::MUTED)))
                .collect();
            lines.extend(text::wrap(&detail, width));
        }
        lines
    }
}
