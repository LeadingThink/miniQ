//! Full-screen home and conversation layout, backed by a scrollable transcript.
use super::{editor::Editor, picker::Picker, text, transcript::Transcript};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::Line,
    widgets::{Block, Paragraph},
    Frame,
};
use serde_json::Value;
use std::time::Duration;

#[path = "activity.rs"]
mod activity;
#[path = "composer.rs"]
mod composer;
#[path = "sidebar.rs"]
mod sidebar;

#[derive(Default)]
pub struct Status {
    pub title: String,
    pub model: String,
    pub effort: String,
    pub mode: String,
    pub cwd: String,
    pub running: bool,
    pub phase: String,
    pub elapsed: Duration,
    pub context: Option<f64>,
    pub queue: usize,
    pub files: Vec<String>,
    pub notice: String,
    pub custom: Option<(String, bool)>,
    pub card: Option<(String, Vec<String>)>,
    pub color: bool,
    pub theme: String,
    pub animations: bool,
}

pub struct Screen {
    pub selection: Option<((usize, usize), (usize, usize))>,
    pub dragging: bool,
    pub card_checked: std::collections::BTreeSet<usize>,
    pub card_hits: Vec<(Rect, usize)>,
    pub reader: Option<super::reader::Reader>,
    pub form: Option<super::forms::Form>,
    pub expanded_tools: std::collections::HashSet<String>,
    pub row_entries: Vec<Option<usize>>,
    pub transcript: Transcript,
    pub picker: Option<Picker>,
    pub sidebar: bool,
    pub expanded: bool,
    pub scroll: Option<usize>,
    pub top: usize,
    pub total: usize,
    pub page_height: usize,
    pub transcript_area: Rect,
    pub composer_area: Rect,
    pub sidebar_area: Rect,
    pub sidebar_offset: usize,
    pub card_selected: usize,
    pub card_offset: usize,
    pub card_area: Rect,
    pub plan: Value,
    cached: Vec<Line<'static>>,
    cache_key: Option<(u64, usize, bool, bool)>,
}

impl Default for Screen {
    fn default() -> Self {
        Self {
            selection: None,
            dragging: false,
            card_checked: Default::default(),
            card_hits: vec![],
            reader: None,
            form: None,
            expanded_tools: std::collections::HashSet::new(),
            row_entries: Vec::new(),
            transcript: Transcript::default(),
            picker: None,
            sidebar: true,
            expanded: false,
            scroll: None,
            top: 0,
            total: 0,
            page_height: 1,
            transcript_area: Rect::default(),
            composer_area: Rect::default(),
            sidebar_area: Rect::default(),
            sidebar_offset: 0,
            card_selected: 0,
            card_offset: 0,
            card_area: Rect::default(),
            plan: Value::Null,
            cached: Vec::new(),
            cache_key: None,
        }
    }
}

impl Screen {
    pub fn invalidate(&mut self) {
        self.cache_key = None;
    }
    pub fn home(&self) -> bool {
        self.transcript.entries.is_empty()
    }

    pub fn scroll_by(&mut self, amount: isize) {
        let bottom = self.total.saturating_sub(self.page_height);
        let top = self
            .scroll
            .unwrap_or(bottom)
            .saturating_add_signed(amount)
            .min(bottom);
        self.scroll = (top < bottom).then_some(top);
    }

    pub fn rows(&mut self, width: usize, color: bool) -> &[Line<'static>] {
        let key = (self.transcript.version, width, self.expanded, color);
        if self.cache_key != Some(key) {
            (self.cached, self.row_entries) =
                self.transcript
                    .layout(width, self.expanded, color, &self.expanded_tools);
            self.cache_key = Some(key);
        }
        &self.cached
    }

    pub fn toggle_tool(&mut self, id: &str) {
        if !self.expanded_tools.remove(id) {
            self.expanded_tools.insert(id.into());
        }
        self.cache_key = None;
    }

    pub fn jump_to(&mut self, id: &str) {
        if let Some(index) = self
            .transcript
            .entries
            .iter()
            .position(|entry| entry.id == id)
        {
            self.scroll = self
                .row_entries
                .iter()
                .position(|owner| *owner == Some(index));
        }
    }

    pub fn draw(&mut self, frame: &mut Frame, editor: &Editor, status: &Status) {
        let area = frame.area();
        let base = if status.color {
            Style::default().fg(text::TEXT).bg(text::BACKGROUND)
        } else {
            Style::default()
        };
        frame.render_widget(Block::default().style(base), area);
        self.card_area = Rect::default();
        self.card_hits.clear();
        self.sidebar_area = Rect::default();
        let min_height = if status.card.is_some() {
            13
        } else if self.picker.is_some() {
            12
        } else {
            7
        };
        if area.width < 12 || area.height < min_height {
            frame.render_widget(Paragraph::new("Enlarge terminal to continue"), area);
            return;
        }
        let home = self.home() && !status.running && status.card.is_none();
        let side_width = if self.sidebar && !home && area.width >= 120 {
            30
        } else {
            0
        };
        let margin = if area.width < 44 { 1 } else { 2 };
        let main = Rect::new(margin, 0, area.width - side_width - margin * 2, area.height);
        let composer_width = if home { main.width.min(75) } else { main.width };
        let (input, cursor) =
            text::input(&editor.view(""), composer_width.saturating_sub(5) as usize);
        let input_height = input.len().max(1).min((area.height / 3).max(1) as usize) as u16;
        let available = area.height - if status.card.is_some() { 7 } else { 1 };
        let composer_height = (input_height + 5).min(available);
        let composer_y = if home {
            ((area.height.saturating_sub(composer_height)) / 2 + 2)
                .min(area.height - composer_height - 1)
        } else {
            area.height - composer_height - 1
        };
        let composer = Rect::new(
            main.x + (main.width - composer_width) / 2,
            composer_y,
            composer_width,
            composer_height,
        );
        self.composer_area = composer;
        if home {
            self.draw_home(frame, composer, status);
        } else {
            self.draw_header(frame, main, status);
            let card_height = if status.card.is_some() {
                (area.height / 3)
                    .clamp(3, 12)
                    .min(composer_y.saturating_sub(3))
            } else {
                0
            };
            let transcript = Rect::new(
                main.x,
                3,
                main.width,
                composer_y.saturating_sub(3 + card_height),
            );
            self.draw_transcript(frame, transcript, status);
            if card_height > 0 {
                self.draw_card(
                    frame,
                    Rect::new(main.x, composer_y - card_height, main.width, card_height),
                    status,
                );
            }
        }
        composer::draw(
            frame,
            composer,
            editor,
            status,
            input,
            cursor,
            self.picker.is_none() && self.reader.is_none() && self.form.is_none(),
        );
        if side_width > 0 {
            self.sidebar_area = Rect::new(area.width - side_width, 0, side_width, area.height - 1);
            sidebar::draw(
                frame,
                self.sidebar_area,
                status,
                &self.plan,
                &mut self.sidebar_offset,
            );
        }
        let footer = if !status.notice.is_empty() {
            status.notice.clone()
        } else if self.scroll.is_some() {
            format!(
                "PgUp/PgDn scroll  ·  ctrl+end latest  ·  {}/{}",
                self.top + 1,
                self.total
            )
        } else {
            "ctrl+p commands   ctrl+x l sessions   ctrl+x m models   ctrl+x b sidebar".into()
        };
        frame.render_widget(
            Paragraph::new(footer).style(Style::default().fg(text::MUTED)),
            Rect::new(main.x, area.height - 1, main.width, 1),
        );
        if let Some(menu) = editor
            .menu
            .as_ref()
            .filter(|_| self.picker.is_none() && status.card.is_none())
        {
            composer::completion(frame, composer, menu);
        }
        if let Some(picker) = self.picker.as_mut() {
            picker.draw(frame);
        }
        if let Some(reader) = self.reader.as_mut() {
            reader.draw(frame);
        }
        if let Some(form) = self.form.as_ref() {
            form.draw(frame);
        }
        if status.color {
            super::theme::apply(frame, &status.theme);
        }
        if !status.color {
            // NO_COLOR preserves layout and emphasis without forcing a palette.
            for cell in &mut frame.buffer_mut().content {
                cell.fg = ratatui::style::Color::Reset;
                cell.bg = ratatui::style::Color::Reset;
            }
        }
    }

    fn draw_home(&self, frame: &mut Frame, composer: Rect, status: &Status) {
        const LOGO: [&str; 4] = [
            "              ▄           ▄",
            "█▀▄▀█ ▀ █▀▀▄  ▀  █▀▀█",
            "█   █ █ █  █  █  █  █",
            "▀   ▀ ▀ ▀  ▀  ▀  ▀▀▀█",
        ];
        if composer.y >= 5 && composer.width >= 30 {
            let logo_width = 28.min(composer.width);
            frame.render_widget(
                Paragraph::new(LOGO.join("\n"))
                    .style(Style::default().fg(text::TEXT).add_modifier(Modifier::BOLD)),
                Rect::new(
                    composer.x + (composer.width - logo_width) / 2,
                    composer.y - 5,
                    logo_width,
                    4,
                ),
            );
        }
        if frame.area().height > 15 {
            let tip = "Ask anything…  / commands  @ files  ! shell";
            frame.render_widget(
                Paragraph::new(tip).style(Style::default().fg(text::MUTED)),
                Rect::new(
                    composer.x + 2,
                    composer.bottom(),
                    composer.width.saturating_sub(4),
                    1,
                ),
            );
        }
        if status.color && frame.area().width > 80 {
            let version = format!("miniQ {}", env!("CARGO_PKG_VERSION"));
            frame.render_widget(
                Paragraph::new(version.clone()).style(Style::default().fg(text::MUTED)),
                Rect::new(
                    frame.area().width.saturating_sub(version.len() as u16 + 2),
                    1,
                    version.len() as u16,
                    1,
                ),
            );
        }
    }

    fn draw_header(&self, frame: &mut Frame, area: Rect, status: &Status) {
        let title = if status.title.is_empty() {
            "New session"
        } else {
            &status.title
        };
        frame.render_widget(
            Paragraph::new(format!("# {title}"))
                .style(Style::default().add_modifier(Modifier::BOLD)),
            Rect::new(area.x + 1, 1, area.width.saturating_sub(2), 1),
        );
    }

    fn draw_transcript(&mut self, frame: &mut Frame, area: Rect, status: &Status) {
        self.transcript_area = area;
        self.page_height = area.height as usize;
        let width = area.width.saturating_sub(1) as usize;
        let pending = activity::response(status)
            .map(|line| text::wrap(&[line], width))
            .unwrap_or_default();
        self.total = self.rows(width, status.color).len() + pending.len();
        let bottom = self.total.saturating_sub(self.page_height);
        self.top = self.scroll.unwrap_or(bottom).min(bottom);
        let visible: Vec<_> = self
            .cached
            .iter()
            .chain(pending.iter())
            .skip(self.top)
            .take(self.page_height)
            .cloned()
            .collect();
        frame.render_widget(Paragraph::new(visible), area);
        self.highlight_selection(frame, area);
        if self.total > self.page_height && area.height > 0 {
            let thumb = (self.top * (area.height - 1) as usize / bottom.max(1)) as u16;
            frame.render_widget(
                Paragraph::new("┃").style(Style::default().fg(text::MUTED)),
                Rect::new(area.right() - 1, area.y + thumb, 1, 1),
            );
        }
    }

    fn draw_card(&mut self, frame: &mut Frame, area: Rect, status: &Status) {
        let Some((body, choices)) = &status.card else {
            return;
        };
        self.card_area = area;
        frame.render_widget(
            Block::default().style(Style::default().bg(text::PANEL)),
            area,
        );
        let rows = text::wrap(&text::styled(body), area.width.saturating_sub(4) as usize);
        let body_height = area.height.saturating_sub(2);
        self.card_offset = self
            .card_offset
            .min(rows.len().saturating_sub(body_height as usize));
        let rows: Vec<_> = rows
            .iter()
            .skip(self.card_offset)
            .take(body_height as usize)
            .cloned()
            .collect();
        frame.render_widget(
            Paragraph::new(rows).style(Style::default().fg(text::ACCENT)),
            Rect::new(
                area.x + 2,
                area.y,
                area.width.saturating_sub(4),
                body_height,
            ),
        );
        self.card_selected = self.card_selected.min(choices.len().saturating_sub(1));
        let line = Line::from(
            choices
                .iter()
                .enumerate()
                .map(|(i, choice)| {
                    let label = format!(
                        " {} {} ",
                        if i == self.card_selected { "›" } else { " " },
                        choice
                    );
                    ratatui::text::Span::styled(
                        label,
                        if i == self.card_selected {
                            Style::default().bg(text::SELECTED).fg(text::ACCENT)
                        } else {
                            Style::default().fg(text::MUTED)
                        },
                    )
                })
                .collect::<Vec<_>>(),
        );
        let compact = !choices.is_empty() && line.width() > area.width.saturating_sub(2) as usize;
        if compact {
            self.card_hits.push((
                Rect::new(
                    area.x + 1,
                    area.bottom() - 2,
                    area.width.saturating_sub(2),
                    1,
                ),
                self.card_selected,
            ));
        } else {
            let mut x = area.x + 1;
            for (index, span) in line.spans.iter().enumerate() {
                self.card_hits.push((
                    Rect::new(x, area.bottom() - 2, span.width() as u16, 1),
                    index,
                ));
                x += span.width() as u16;
            }
        }
        let line = if compact {
            Line::styled(
                format!(
                    "‹ {}/{}  {} ›",
                    self.card_selected + 1,
                    choices.len(),
                    choices[self.card_selected]
                ),
                Style::default().fg(text::ACCENT),
            )
        } else {
            line
        };
        frame.render_widget(
            Paragraph::new(line),
            Rect::new(
                area.x + 1,
                area.bottom() - 2,
                area.width.saturating_sub(2),
                1,
            ),
        );
        frame.render_widget(
            Paragraph::new("←→ choose · space toggle · enter select/submit · alt+d details")
                .style(Style::default().fg(text::MUTED)),
            Rect::new(
                area.x + 2,
                area.bottom() - 1,
                area.width.saturating_sub(4),
                1,
            ),
        );
    }
}

#[cfg(test)]
#[path = "screen_tests.rs"]
mod tests;
