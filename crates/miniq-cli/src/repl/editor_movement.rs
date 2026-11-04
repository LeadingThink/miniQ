//! Prompt cursor movement and history browsing.
use super::*;

impl Editor {
    pub(super) fn delete_forward(&mut self) {
        if self.cursor < self.buffer.len() {
            self.buffer.remove(self.cursor);
        }
        self.refresh_menu();
    }

    pub(super) fn left(&mut self) {
        if let Some(c) = self.buffer[..self.cursor].chars().next_back() {
            self.cursor -= c.len_utf8();
        }
    }

    pub(super) fn right(&mut self) {
        if let Some(c) = self.buffer[self.cursor..].chars().next() {
            self.cursor += c.len_utf8();
        }
    }

    pub(super) fn line_start(&self) -> usize {
        self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1)
    }

    pub(super) fn line_end(&self) -> usize {
        self.buffer[self.cursor..]
            .find('\n')
            .map_or(self.buffer.len(), |i| self.cursor + i)
    }

    pub(super) fn word_left(&self) -> usize {
        let head = &self.buffer[..self.cursor];
        let trimmed = head.trim_end_matches(|c: char| !c.is_alphanumeric());
        trimmed
            .rfind(|c: char| !c.is_alphanumeric())
            .map_or(0, |i| {
                i + trimmed[i..].chars().next().map_or(1, char::len_utf8)
            })
    }

    pub(super) fn word_right(&self) -> usize {
        let tail = &self.buffer[self.cursor..];
        let skip = tail.len()
            - tail
                .trim_start_matches(|c: char| !c.is_alphanumeric())
                .len();
        let rest = &tail[skip..];
        let word = rest
            .find(|c: char| !c.is_alphanumeric())
            .unwrap_or(rest.len());
        self.cursor + skip + word
    }

    pub(super) fn vertical(&mut self, direction: i32) {
        let start = self.line_start();
        let column = self.buffer[start..self.cursor].chars().count();
        let target = if direction < 0 {
            let prev_end = start - 1;
            self.buffer[..prev_end].rfind('\n').map_or(0, |i| i + 1)
        } else {
            self.line_end() + 1
        };
        let line_end = self.buffer[target..]
            .find('\n')
            .map_or(self.buffer.len(), |i| target + i);
        let mut cursor = target;
        for c in self.buffer[target..line_end].chars().take(column) {
            cursor += c.len_utf8();
        }
        self.cursor = cursor;
    }

    pub(super) fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let index = match self.browsing {
            None => {
                self.draft = self.buffer.clone();
                self.history.len() - 1
            }
            Some(0) => 0,
            Some(i) => i - 1,
        };
        self.browsing = Some(index);
        self.buffer = self.history[index].clone();
        self.cursor = self.buffer.len();
        self.menu = None;
    }

    pub(super) fn history_next(&mut self) {
        let Some(index) = self.browsing else {
            return;
        };
        if index + 1 >= self.history.len() {
            self.browsing = None;
            self.buffer = std::mem::take(&mut self.draft);
        } else {
            self.browsing = Some(index + 1);
            self.buffer = self.history[index + 1].clone();
        }
        self.cursor = self.buffer.len();
        self.menu = None;
    }
}
