//! Hit testing uses the same visible rows and Unicode cells as the renderer.
use super::{screen::Screen, transcript::Kind, Editor, Repl};
use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

impl Screen {
    fn position(&self, x: u16, y: u16) -> (usize, usize) {
        (
            self.top + y.saturating_sub(self.transcript_area.y) as usize,
            x.saturating_sub(self.transcript_area.x) as usize,
        )
    }

    pub fn selected_text(&mut self) -> Option<String> {
        let (a, b) = self.selection.filter(|(a, b)| a != b)?;
        let (start, end) = if a < b { (a, b) } else { (b, a) };
        let width = self.transcript_area.width.saturating_sub(1) as usize;
        let rows = self.rows(width, false);
        let mut result = Vec::new();
        for (row, line) in rows
            .iter()
            .enumerate()
            .skip(start.0)
            .take(end.0 - start.0 + 1)
        {
            let from = if row == start.0 { start.1 } else { 0 };
            let to = if row == end.0 { end.1 } else { usize::MAX };
            let text: String = line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect();
            let mut x = 0;
            let selected: String = text
                .graphemes(true)
                .filter(|g| {
                    let previous = x;
                    x += g.width();
                    previous < to && x > from
                })
                .collect();
            result.push(selected);
        }
        Some(result.join("\n"))
    }

    pub fn highlight_selection(&self, frame: &mut ratatui::Frame, area: ratatui::layout::Rect) {
        let Some((a, b)) = self.selection.filter(|(a, b)| a != b) else {
            return;
        };
        let (start, end) = if a < b { (a, b) } else { (b, a) };
        for y in area.y..area.bottom() {
            let row = self.top + (y - area.y) as usize;
            if row < start.0 || row > end.0 {
                continue;
            }
            let from = if row == start.0 { start.1 } else { 0 };
            let to = if row == end.0 {
                end.1
            } else {
                area.width as usize
            };
            for x in from..to.min(area.width as usize) {
                frame.buffer_mut()[(area.x + x as u16, y)].set_bg(super::text::SELECTED);
            }
        }
    }

    pub fn navigate_message(&mut self, next: bool) {
        let positions: Vec<_> = self
            .row_entries
            .iter()
            .enumerate()
            .filter_map(|(row, index)| {
                let index = (*index)?;
                if row > 0 && self.row_entries[row - 1] == Some(index) {
                    return None;
                }
                matches!(
                    self.transcript.entries[index].kind,
                    Kind::User | Kind::Assistant
                )
                .then_some(row)
            })
            .collect();
        self.scroll = if next {
            positions.into_iter().find(|row| *row > self.top)
        } else {
            positions
                .into_iter()
                .rev()
                .find(|row| *row < self.top)
                .or(Some(0))
        };
    }
}

pub async fn interact(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut crate::client::Client,
    event: MouseEvent,
) -> anyhow::Result<bool> {
    let (x, y) = (event.column, event.row);
    if matches!(event.kind, MouseEventKind::Down(MouseButton::Left)) {
        if let Some((_, index)) = repl
            .ui
            .card_hits
            .iter()
            .find(|(area, _)| area.contains((x, y).into()))
        {
            repl.ui.card_selected = *index;
            repl.choose_card(client, false).await?;
            return Ok(true);
        }
        let area = repl.ui.composer_area;
        if let Some(menu) = editor.menu.as_ref() {
            let count = menu
                .items
                .len()
                .min(area.y.saturating_sub(1) as usize)
                .min(8);
            let first_y = area.y.saturating_sub(count as u16 + 1);
            if x >= area.x && x < area.right() && y >= first_y && y < first_y + count as u16 {
                editor.select_completion(
                    menu.selected.saturating_sub(count - 1) + (y - first_y) as usize,
                );
                return Ok(true);
            }
        }
        if area.contains((x, y).into()) {
            if y == area.bottom() - 3 {
                repl.open_picker(client, super::picker::Purpose::Models)
                    .await?;
            } else {
                let width = area.width.saturating_sub(5).max(1) as usize;
                let (_, cursor) = super::text::input(&editor.view(""), width);
                let first = cursor
                    .0
                    .saturating_sub(area.height.saturating_sub(6) as usize);
                editor.click(
                    width,
                    first + y.saturating_sub(area.y + 1) as usize,
                    x.saturating_sub(area.x + 3) as usize,
                );
            }
            return Ok(true);
        }
    }
    if !repl.ui.transcript_area.contains((x, y).into()) {
        return Ok(false);
    }
    let point = repl.ui.position(x, y);
    match event.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            repl.ui.selection = Some((point, point));
            repl.ui.dragging = true;
        }
        MouseEventKind::Drag(MouseButton::Left) if repl.ui.dragging => {
            if let Some((_, end)) = repl.ui.selection.as_mut() {
                *end = point;
            }
        }
        MouseEventKind::Up(MouseButton::Left) if repl.ui.dragging => {
            repl.ui.dragging = false;
            if repl
                .ui
                .selection
                .is_some_and(|(start, end)| start == end && start == point)
            {
                if let Some(entry) = repl
                    .ui
                    .row_entries
                    .get(point.0)
                    .copied()
                    .flatten()
                    .and_then(|index| repl.ui.transcript.entries.get(index))
                {
                    let (id, kind) = (entry.id.clone(), entry.kind.clone());
                    match kind {
                        Kind::Tool => repl.inspect_tool(&id, false),
                        Kind::User | Kind::Assistant => {
                            repl.choose_panel(editor, client, super::picker::Purpose::Messages, &id)
                                .await?
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => return Ok(false),
    }
    Ok(true)
}
