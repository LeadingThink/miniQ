//! Scrollable detail view used by tools, diffs, attachments and diagnostics.
use super::text;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::Line,
    widgets::{Block, Clear, Paragraph},
    Frame,
};

pub struct Reader {
    pub image: Option<super::image_preview::ImagePreview>,
    pub file: Option<std::path::PathBuf>,
    pub source: Option<(String, serde_json::Value)>,
    pub request: Option<u64>,
    pub refreshed: std::time::Instant,
    pub live: bool,
    pub error: Option<String>,
    pub process: Option<u64>,
    pub title: String,
    pub body: String,
    pub offset: usize,
    pub query: String,
    pub searching: bool,
    pub area: Rect,
    page: usize,
    hunks: Vec<usize>,
}

impl Reader {
    pub fn new(title: &str, body: &str) -> Self {
        Self {
            image: None,
            file: None,
            source: None,
            request: None,
            refreshed: std::time::Instant::now(),
            live: false,
            error: None,
            process: None,
            title: title.into(),
            body: body.into(),
            offset: 0,
            query: String::new(),
            searching: false,
            area: Rect::default(),
            page: 1,
            hunks: vec![],
        }
    }

    pub fn key(&mut self, key: KeyEvent) -> bool {
        if self.searching {
            match key.code {
                KeyCode::Esc | KeyCode::Enter => self.searching = false,
                KeyCode::Backspace => {
                    self.query.pop();
                    self.offset = 0;
                }
                KeyCode::Char(c) => {
                    self.query.push(c);
                    self.offset = 0;
                }
                _ => {}
            }
            return false;
        }
        match (key.code, key.modifiers) {
            (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => return true,
            (KeyCode::Up | KeyCode::Char('k'), _) => self.offset = self.offset.saturating_sub(1),
            (KeyCode::Down | KeyCode::Char('j'), _) => self.offset += 1,
            (KeyCode::PageUp, _) => self.offset = self.offset.saturating_sub(self.page),
            (KeyCode::PageDown, _) | (KeyCode::Char(' '), _) => self.offset += self.page,
            (KeyCode::Home, _) => self.offset = 0,
            (KeyCode::End, _) => self.offset = usize::MAX,
            (KeyCode::Char('n'), KeyModifiers::NONE) => {
                if let Some(row) = self.hunks.iter().find(|row| **row > self.offset) {
                    self.offset = *row;
                }
            }
            (KeyCode::Char('N'), _) => {
                if let Some(row) = self.hunks.iter().rev().find(|row| **row < self.offset) {
                    self.offset = *row;
                }
            }
            (KeyCode::Char('/'), _) | (KeyCode::Char('f'), KeyModifiers::CONTROL) => {
                self.searching = true
            }
            _ => {}
        }
        false
    }

    pub fn draw(&mut self, frame: &mut Frame) {
        let size = frame.area();
        let area = Rect::new(
            1,
            1,
            size.width.saturating_sub(2),
            size.height.saturating_sub(2),
        );
        self.area = area;
        if area.width < 4 || area.height < 5 {
            return;
        }
        frame.render_widget(Clear, area);
        frame.render_widget(
            Block::default().style(Style::default().bg(text::PANEL)),
            area,
        );
        let width = area.width.saturating_sub(4) as usize;
        let lines = text::styled(&self.body);
        let query = self.query.to_lowercase();
        let lines: Vec<_> = lines
            .into_iter()
            .filter(|line| {
                query.is_empty()
                    || line
                        .spans
                        .iter()
                        .map(|span| span.content.as_ref())
                        .collect::<String>()
                        .to_lowercase()
                        .contains(&query)
            })
            .collect();
        let rows = text::wrap(&lines, width.max(1));
        self.hunks = rows
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
                    .starts_with("@@")
                    .then_some(index)
            })
            .collect();
        self.page = area.height.saturating_sub(4) as usize;
        self.offset = self.offset.min(rows.len().saturating_sub(self.page));
        frame.render_widget(
            Paragraph::new(self.title.clone()).style(
                Style::default()
                    .fg(text::ACCENT)
                    .add_modifier(Modifier::BOLD),
            ),
            Rect::new(area.x + 2, area.y, width as u16, 1),
        );
        let visible: Vec<Line<'static>> =
            rows.into_iter().skip(self.offset).take(self.page).collect();
        frame.render_widget(
            Paragraph::new(visible),
            Rect::new(area.x + 2, area.y + 2, width as u16, self.page as u16),
        );
        if let Some(image) = self.image.as_mut() {
            image.draw(
                frame,
                Rect::new(
                    area.x + 2,
                    area.y + 3,
                    width as u16,
                    self.page.saturating_sub(1) as u16,
                ),
            );
        }
        let footer = if let Some(error) = &self.error {
            format!("{error} · ctrl+r retry")
        } else if self.searching || !self.query.is_empty() {
            format!("/{}  enter finish · esc close", self.query)
        } else {
            "↑↓/PgUp/PgDn scroll · / filter · ctrl+y copy · ctrl+r refresh · esc close".into()
        };
        frame.render_widget(
            Paragraph::new(footer).style(Style::default().fg(text::MUTED)),
            Rect::new(area.x + 2, area.bottom() - 1, width as u16, 1),
        );
    }
}

impl super::Repl {
    pub(super) fn remote_detail(
        &mut self,
        title: &str,
        method: &str,
        params: serde_json::Value,
        live: bool,
    ) {
        let mut reader = Reader::new(title, "Loading…");
        reader.source = Some((method.into(), params));
        reader.live = live;
        self.ui.reader = Some(reader);
        self.refresh_reader();
    }

    pub(super) fn refresh_reader(&mut self) {
        let Some(reader) = self
            .ui
            .reader
            .as_ref()
            .filter(|reader| reader.request.is_none())
        else {
            return;
        };
        let Some((method, params)) = reader.source.clone() else {
            return;
        };
        let id = self.rpc(
            "Loading details",
            super::jobs::Effect::Reader,
            &method,
            params,
        );
        if let Some(reader) = self.ui.reader.as_mut() {
            reader.request = Some(id);
            reader.error = None;
        }
    }
}
