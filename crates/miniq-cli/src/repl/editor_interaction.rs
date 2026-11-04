//! Lossless paste folding and cell-based mouse editing.
use super::*;
use unicode_segmentation::UnicodeSegmentation;

impl Editor {
    pub fn paste(&mut self, text: &str) {
        self.insert(text);
        self.folded = text.lines().count() > 8 || text.chars().count() > 1000;
        if self.folded {
            self.menu = None;
        }
    }

    pub fn click(&mut self, width: usize, row: usize, column: usize) {
        if self.folded {
            self.folded = false;
            return;
        }
        self.search = None;
        self.menu = None;
        let width = width.max(1);
        let (mut y, mut x) = (0, 0);
        let mut candidate = self.buffer.len();
        for (offset, grapheme) in self.buffer.grapheme_indices(true) {
            if grapheme == "\n" {
                if y == row {
                    candidate = offset;
                    break;
                }
                y += 1;
                x = 0;
                continue;
            }
            let cells = grapheme.width();
            if x > 0 && x + cells > width {
                y += 1;
                x = 0;
            }
            if y > row || (y == row && column < x + cells) {
                candidate = offset;
                break;
            }
            x += cells;
        }
        self.set_cursor(candidate);
    }

    pub fn select_completion(&mut self, index: usize) {
        if let Some(menu) = self.menu.as_mut() {
            if index < menu.items.len() {
                menu.selected = index;
                self.accept_menu();
            }
        }
    }
}

impl Editor {
    /// Lines to display (prompt on the first line, `… ` continuation prompts).
    pub fn view(&self, prompt: &str) -> View {
        if self.folded {
            let line = format!(
                "[Pasted {} lines · {} characters · edit to expand]",
                self.buffer.lines().count(),
                self.buffer.chars().count()
            );
            return View {
                cursor: (0, line.width()),
                lines: vec![line],
            };
        }
        if let Some(search) = &self.search {
            let found = search
                .matched
                .map(|i| self.history[i].replace('\n', "⏎"))
                .unwrap_or_default();
            let line = format!("(reverse-i-search)`{}': {}", search.query, found);
            let column = UnicodeWidthStr::width(line.as_str());
            return View {
                lines: vec![line],
                cursor: (0, column),
            };
        }
        let continuation = if prompt.is_empty() {
            String::new()
        } else {
            " ".repeat(UnicodeWidthStr::width(prompt).saturating_sub(2)) + "… "
        };
        let mut lines = Vec::new();
        let mut cursor = (0, 0);
        let mut offset = 0;
        for (row, text) in self.buffer.split('\n').enumerate() {
            let lead = if row == 0 { prompt } else { &continuation };
            if self.cursor >= offset && self.cursor <= offset + text.len() {
                let before = &text[..self.cursor - offset];
                cursor = (
                    row,
                    UnicodeWidthStr::width(lead) + UnicodeWidthStr::width(before),
                );
            }
            lines.push(format!("{lead}{text}"));
            offset += text.len() + 1;
        }
        View { lines, cursor }
    }
}
