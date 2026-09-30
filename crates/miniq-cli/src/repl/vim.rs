//! A small vi-style modal layer for the prompt editor.
//!
//! The editor owns the buffer; in NORMAL mode it hands keys to [`Vim::normal_key`],
//! which edits the buffer/cursor in place and reports what the editor must do next.
//! INSERT mode is the regular (keymap driven) editor.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

const UNDO_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Insert,
    Normal,
}

/// What the editor should do after a NORMAL mode key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// Buffer/cursor/state updated; redraw.
    Handled,
    /// Not a vim key: let the regular keymap handle it (Ctrl-C, arrows, ...).
    Unhandled,
    Submit,
    /// `k` on the first line: previous history entry.
    HistoryPrev,
    /// `j` on the last line: next history entry.
    HistoryNext,
    /// Esc with nothing pending (e.g. cancel a running turn).
    Escape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    None,
    Operator(char),
    /// `g` waiting for a second `g`.
    G,
    /// `r` waiting for the replacement char.
    Replace,
}

#[derive(Debug, Clone)]
pub struct Vim {
    pub mode: Mode,
    pending: Pending,
    count: Option<usize>,
    /// Count typed before an operator (`2dw`).
    operator_count: Option<usize>,
    register: String,
    linewise: bool,
    undo: Vec<(String, usize)>,
}

impl Default for Vim {
    fn default() -> Self {
        Self {
            mode: Mode::Insert,
            pending: Pending::None,
            count: None,
            operator_count: None,
            register: String::new(),
            linewise: false,
            undo: Vec::new(),
        }
    }
}

impl Vim {
    pub fn indicator(&self) -> &'static str {
        match self.mode {
            Mode::Insert => "-- INSERT --",
            Mode::Normal => "-- NORMAL --",
        }
    }

    /// Forget per-entry state after a submit or clear (the yank register survives).
    pub fn reset(&mut self) {
        self.mode = Mode::Insert;
        self.clear_pending();
        self.undo.clear();
    }

    fn clear_pending(&mut self) {
        self.pending = Pending::None;
        self.count = None;
        self.operator_count = None;
    }

    /// Leave INSERT mode: the cursor steps back onto the last inserted char, as in vi.
    pub fn enter_normal(&mut self, buffer: &str, cursor: &mut usize) {
        if self.mode == Mode::Insert {
            // Drop the snapshot taken when entering insert mode if nothing changed.
            if self.undo.last().is_some_and(|(text, _)| text == buffer) {
                self.undo.pop();
            }
        }
        self.mode = Mode::Normal;
        self.clear_pending();
        if *cursor > line_start(buffer, *cursor) {
            *cursor = prev_char(buffer, *cursor);
        }
        clamp(buffer, cursor);
    }

    fn enter_insert(&mut self, buffer: &str, cursor: usize) {
        self.snapshot(buffer, cursor);
        self.mode = Mode::Insert;
        self.clear_pending();
    }

    fn snapshot(&mut self, buffer: &str, cursor: usize) {
        if self.undo.last().is_some_and(|(text, _)| text == buffer) {
            return;
        }
        self.undo.push((buffer.to_owned(), cursor));
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
    }

    pub fn pending(&self) -> bool {
        self.pending != Pending::None || self.count.is_some() || self.operator_count.is_some()
    }

    /// Handle one key in NORMAL mode.
    pub fn normal_key(
        &mut self,
        key: &KeyEvent,
        buffer: &mut String,
        cursor: &mut usize,
    ) -> Effect {
        let modifiers = key.modifiers - KeyModifiers::SHIFT;
        if !modifiers.is_empty() {
            self.clear_pending();
            return Effect::Unhandled;
        }
        let c = match key.code {
            KeyCode::Char(c) => c,
            KeyCode::Esc => {
                if self.pending() {
                    self.clear_pending();
                    return Effect::Handled;
                }
                return Effect::Escape;
            }
            KeyCode::Enter => {
                self.clear_pending();
                return Effect::Submit;
            }
            KeyCode::Backspace => 'h',
            _ => {
                self.clear_pending();
                return Effect::Unhandled;
            }
        };

        match self.pending {
            Pending::Replace => {
                let count = self.take_count();
                self.clear_pending();
                self.replace(buffer, *cursor, c, count);
                return Effect::Handled;
            }
            Pending::G => {
                self.pending = Pending::None;
                if c == 'g' {
                    let count = self.count.take();
                    self.operator_count = None;
                    *cursor = match count {
                        Some(n) => nth_line_start(buffer, n.saturating_sub(1)),
                        None => 0,
                    };
                    return Effect::Handled;
                }
                self.clear_pending();
                return Effect::Handled;
            }
            Pending::Operator(op) => {
                return self.operator(op, c, buffer, cursor);
            }
            Pending::None => {}
        }

        if let Some(digit) = c.to_digit(10) {
            if digit != 0 || self.count.is_some() {
                let count = self.count.unwrap_or(0);
                self.count = Some(
                    count
                        .saturating_mul(10)
                        .saturating_add(digit as usize)
                        .min(9999),
                );
                return Effect::Handled;
            }
        }

        let explicit = self.count.is_some() || self.operator_count.is_some();
        let count = self.take_count();
        let effect = match c {
            'h' => {
                for _ in 0..count {
                    if *cursor > line_start(buffer, *cursor) {
                        *cursor = prev_char(buffer, *cursor);
                    }
                }
                Effect::Handled
            }
            'l' | ' ' => {
                for _ in 0..count {
                    let next = next_char(buffer, *cursor);
                    if next < line_end(buffer, *cursor) {
                        *cursor = next;
                    }
                }
                Effect::Handled
            }
            'j' | 'k' => {
                let down = c == 'j';
                for _ in 0..count {
                    let moved = if down {
                        line_down(buffer, cursor)
                    } else {
                        line_up(buffer, cursor)
                    };
                    if !moved {
                        return if down {
                            Effect::HistoryNext
                        } else {
                            Effect::HistoryPrev
                        };
                    }
                }
                Effect::Handled
            }
            'w' | 'b' | 'e' | '0' | '^' | '$' => {
                *cursor = motion(buffer, *cursor, c, count);
                Effect::Handled
            }
            'G' => {
                *cursor = if explicit {
                    nth_line_start(buffer, count - 1)
                } else {
                    nth_line_start(buffer, usize::MAX)
                };
                Effect::Handled
            }
            'g' => {
                self.pending = Pending::G;
                self.count = explicit.then_some(count);
                return Effect::Handled;
            }
            'i' => {
                self.enter_insert(buffer, *cursor);
                Effect::Handled
            }
            'a' => {
                self.enter_insert(buffer, *cursor);
                if *cursor < line_end(buffer, *cursor) {
                    *cursor = next_char(buffer, *cursor);
                }
                return Effect::Handled;
            }
            'I' => {
                self.enter_insert(buffer, *cursor);
                *cursor = first_non_blank(buffer, *cursor);
                Effect::Handled
            }
            'A' => {
                self.enter_insert(buffer, *cursor);
                *cursor = line_end(buffer, *cursor);
                return Effect::Handled;
            }
            'o' => {
                self.enter_insert(buffer, *cursor);
                let end = line_end(buffer, *cursor);
                buffer.insert(end, '\n');
                *cursor = end + 1;
                return Effect::Handled;
            }
            'O' => {
                self.enter_insert(buffer, *cursor);
                let start = line_start(buffer, *cursor);
                buffer.insert(start, '\n');
                *cursor = start;
                return Effect::Handled;
            }
            'x' | 'X' => {
                self.snapshot(buffer, *cursor);
                let (start, end) = if c == 'x' {
                    let end = line_end(buffer, *cursor);
                    let mut stop = *cursor;
                    for _ in 0..count {
                        if stop < end {
                            stop = next_char(buffer, stop);
                        }
                    }
                    (*cursor, stop)
                } else {
                    let begin = line_start(buffer, *cursor);
                    let mut start = *cursor;
                    for _ in 0..count {
                        if start > begin {
                            start = prev_char(buffer, start);
                        }
                    }
                    (start, *cursor)
                };
                if start < end {
                    self.yank(&buffer[start..end], false);
                    buffer.replace_range(start..end, "");
                    *cursor = start;
                }
                Effect::Handled
            }
            'D' | 'C' => {
                self.snapshot(buffer, *cursor);
                let end = line_end(buffer, *cursor);
                self.yank(&buffer[*cursor..end], false);
                buffer.replace_range(*cursor..end, "");
                if c == 'C' {
                    self.mode = Mode::Insert;
                    return Effect::Handled;
                }
                Effect::Handled
            }
            'd' | 'c' | 'y' => {
                self.pending = Pending::Operator(c);
                self.operator_count = (count > 1).then_some(count);
                return Effect::Handled;
            }
            'p' | 'P' => {
                self.put(buffer, cursor, c == 'p', count);
                Effect::Handled
            }
            'u' => {
                for _ in 0..count {
                    if let Some((text, at)) = self.undo.pop() {
                        *buffer = text;
                        *cursor = at.min(buffer.len());
                    }
                }
                Effect::Handled
            }
            'r' => {
                self.pending = Pending::Replace;
                self.count = explicit.then_some(count);
                return Effect::Handled;
            }
            _ => Effect::Handled,
        };
        clamp(buffer, cursor);
        effect
    }

    fn take_count(&mut self) -> usize {
        let count = self.count.take().unwrap_or(1);
        let operator = self.operator_count.take().unwrap_or(1);
        count.saturating_mul(operator).clamp(1, 9999)
    }

    fn yank(&mut self, text: &str, linewise: bool) {
        self.register = text.to_owned();
        self.linewise = linewise;
    }

    fn replace(&mut self, buffer: &mut String, cursor: usize, c: char, count: usize) {
        if c == '\n' || c == '\r' {
            return;
        }
        let end = line_end(buffer, cursor);
        let mut stop = cursor;
        for _ in 0..count {
            if stop >= end {
                return; // vi refuses to replace past the end of the line
            }
            stop = next_char(buffer, stop);
        }
        self.snapshot(buffer, cursor);
        let replacement: String = std::iter::repeat_n(c, count).collect();
        buffer.replace_range(cursor..stop, &replacement);
    }

    fn put(&mut self, buffer: &mut String, cursor: &mut usize, after: bool, count: usize) {
        if self.register.is_empty() && !self.linewise {
            return;
        }
        self.snapshot(buffer, *cursor);
        if self.linewise {
            let block = vec![self.register.as_str(); count].join("\n");
            if after {
                let end = line_end(buffer, *cursor);
                buffer.insert_str(end, &format!("\n{block}"));
                *cursor = end + 1;
            } else {
                let start = line_start(buffer, *cursor);
                buffer.insert_str(start, &format!("{block}\n"));
                *cursor = start;
            }
        } else {
            let text = self.register.repeat(count);
            let at = if after && *cursor < line_end(buffer, *cursor) {
                next_char(buffer, *cursor)
            } else {
                *cursor
            };
            buffer.insert_str(at, &text);
            *cursor = prev_char(buffer, at + text.len()).max(at);
        }
        clamp(buffer, cursor);
    }

    fn operator(&mut self, op: char, c: char, buffer: &mut String, cursor: &mut usize) -> Effect {
        if let Some(digit) = c.to_digit(10) {
            if digit != 0 || self.count.is_some() {
                let count = self.count.unwrap_or(0);
                self.count = Some(
                    count
                        .saturating_mul(10)
                        .saturating_add(digit as usize)
                        .min(9999),
                );
                return Effect::Handled;
            }
        }
        let count = self.take_count();
        self.pending = Pending::None;
        let range = if c == op {
            // dd / cc / yy: whole lines.
            let start = line_start(buffer, *cursor);
            let mut end = line_end(buffer, *cursor);
            for _ in 1..count {
                if end >= buffer.len() {
                    break;
                }
                end = line_end(buffer, end + 1);
            }
            let text = buffer[start..end].to_owned();
            self.yank(&text, true);
            match op {
                'y' => {}
                'c' => {
                    self.snapshot(buffer, *cursor);
                    buffer.replace_range(start..end, "");
                    *cursor = start;
                    self.mode = Mode::Insert;
                    return Effect::Handled;
                }
                _ => {
                    self.snapshot(buffer, *cursor);
                    let (from, to) = if end < buffer.len() {
                        (start, end + 1)
                    } else if start > 0 {
                        (start - 1, end)
                    } else {
                        (start, end)
                    };
                    buffer.replace_range(from..to, "");
                    *cursor = line_start(buffer, from.min(buffer.len()));
                    *cursor = first_non_blank(buffer, *cursor);
                }
            }
            clamp(buffer, cursor);
            return Effect::Handled;
        } else {
            match c {
                // `cw` behaves like `ce` (does not eat the following whitespace).
                'w' if op == 'c' && !is_blank_at(buffer, *cursor) => {
                    let end = motion(buffer, *cursor, 'e', count);
                    (*cursor, next_char(buffer, end))
                }
                'w' => {
                    let target = motion(buffer, *cursor, 'w', count);
                    // `dw` on the last word of a line stops at the end of that line.
                    let end = line_end(buffer, *cursor);
                    (
                        *cursor,
                        if target > end && end > *cursor {
                            end
                        } else {
                            target
                        },
                    )
                }
                'e' => {
                    let end = motion(buffer, *cursor, 'e', count);
                    (*cursor, next_char(buffer, end))
                }
                'b' | '0' | '^' => {
                    let target = motion(buffer, *cursor, c, count);
                    (target.min(*cursor), target.max(*cursor))
                }
                '$' => (*cursor, line_end(buffer, *cursor)),
                'h' => {
                    let begin = line_start(buffer, *cursor);
                    let mut start = *cursor;
                    for _ in 0..count {
                        if start > begin {
                            start = prev_char(buffer, start);
                        }
                    }
                    (start, *cursor)
                }
                'l' => {
                    let end = line_end(buffer, *cursor);
                    let mut stop = *cursor;
                    for _ in 0..count {
                        if stop < end {
                            stop = next_char(buffer, stop);
                        }
                    }
                    (*cursor, stop)
                }
                _ => {
                    self.clear_pending();
                    return Effect::Handled;
                }
            }
        };
        let (start, end) = (range.0.min(buffer.len()), range.1.min(buffer.len()));
        if start < end {
            let text = buffer[start..end].to_owned();
            self.yank(&text, false);
            if op != 'y' {
                self.snapshot(buffer, *cursor);
                buffer.replace_range(start..end, "");
            }
        }
        *cursor = start;
        if op == 'c' {
            self.mode = Mode::Insert;
            return Effect::Handled;
        }
        clamp(buffer, cursor);
        Effect::Handled
    }
}

fn prev_char(s: &str, i: usize) -> usize {
    s[..i].char_indices().next_back().map_or(0, |(j, _)| j)
}

fn next_char(s: &str, i: usize) -> usize {
    s[i..].chars().next().map_or(i, |c| i + c.len_utf8())
}

fn char_at(s: &str, i: usize) -> Option<char> {
    s[i..].chars().next()
}

fn is_blank_at(s: &str, i: usize) -> bool {
    char_at(s, i).is_none_or(char::is_whitespace)
}

fn line_start(s: &str, i: usize) -> usize {
    s[..i].rfind('\n').map_or(0, |j| j + 1)
}

fn line_end(s: &str, i: usize) -> usize {
    s[i..].find('\n').map_or(s.len(), |j| i + j)
}

fn first_non_blank(s: &str, i: usize) -> usize {
    let start = line_start(s, i);
    let end = line_end(s, i);
    s[start..end]
        .char_indices()
        .find(|(_, c)| !c.is_whitespace())
        .map_or(end, |(j, _)| start + j)
}

/// Start of the `n`th line (0-based), or of the last line when out of range.
fn nth_line_start(s: &str, n: usize) -> usize {
    let mut start = 0;
    for _ in 0..n {
        match s[start..].find('\n') {
            Some(j) => start += j + 1,
            None => break,
        }
    }
    first_non_blank(s, start)
}

/// Normal mode cursor sits on a char: never past the last char of a non-empty line.
fn clamp(s: &str, cursor: &mut usize) {
    *cursor = (*cursor).min(s.len());
    while !s.is_char_boundary(*cursor) {
        *cursor -= 1;
    }
    let start = line_start(s, *cursor);
    let end = line_end(s, *cursor);
    if *cursor >= end && end > start {
        *cursor = prev_char(s, end);
    }
}

fn column(s: &str, i: usize) -> usize {
    s[line_start(s, i)..i].chars().count()
}

fn at_column(s: &str, start: usize, col: usize) -> usize {
    let end = line_end(s, start);
    s[start..end]
        .char_indices()
        .nth(col)
        .map_or(end, |(j, _)| start + j)
}

fn line_down(s: &str, cursor: &mut usize) -> bool {
    let end = line_end(s, *cursor);
    if end >= s.len() {
        return false;
    }
    let col = column(s, *cursor);
    *cursor = at_column(s, end + 1, col);
    clamp(s, cursor);
    true
}

fn line_up(s: &str, cursor: &mut usize) -> bool {
    let start = line_start(s, *cursor);
    if start == 0 {
        return false;
    }
    let col = column(s, *cursor);
    *cursor = at_column(s, line_start(s, start - 1), col);
    clamp(s, cursor);
    true
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Class {
    Blank,
    Word,
    Punct,
}

fn class(c: char) -> Class {
    if c.is_whitespace() {
        Class::Blank
    } else if c.is_alphanumeric() || c == '_' {
        Class::Word
    } else {
        Class::Punct
    }
}

fn word_forward(s: &str, mut i: usize) -> usize {
    if let Some(c) = char_at(s, i) {
        let start = class(c);
        if start != Class::Blank {
            while char_at(s, i).is_some_and(|c| class(c) == start) {
                i = next_char(s, i);
            }
        }
    }
    while char_at(s, i).is_some_and(|c| class(c) == Class::Blank) {
        i = next_char(s, i);
    }
    i
}

fn word_back(s: &str, mut i: usize) -> usize {
    while i > 0 && class(char_at(s, prev_char(s, i)).unwrap_or(' ')) == Class::Blank {
        i = prev_char(s, i);
    }
    if i == 0 {
        return 0;
    }
    let target = class(char_at(s, prev_char(s, i)).unwrap_or(' '));
    while i > 0 && class(char_at(s, prev_char(s, i)).unwrap_or(' ')) == target {
        i = prev_char(s, i);
    }
    i
}

fn word_end(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return i;
    }
    i = next_char(s, i);
    while char_at(s, i).is_some_and(|c| class(c) == Class::Blank) {
        i = next_char(s, i);
    }
    let Some(c) = char_at(s, i) else {
        return prev_char(s, s.len());
    };
    let target = class(c);
    while char_at(s, next_char(s, i)).is_some_and(|c| class(c) == target) {
        i = next_char(s, i);
    }
    i
}

/// Apply a cursor motion `count` times.
fn motion(s: &str, cursor: usize, c: char, count: usize) -> usize {
    match c {
        '0' => line_start(s, cursor),
        '^' => first_non_blank(s, cursor),
        '$' => line_end(s, cursor),
        'w' => (0..count).fold(cursor, |i, _| word_forward(s, i)),
        'b' => (0..count).fold(cursor, |i, _| word_back(s, i)),
        'e' => (0..count).fold(cursor, |i, _| word_end(s, i)),
        _ => cursor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run `keys` in normal mode on `text` with the cursor at `at`.
    fn run(text: &str, at: usize, keys: &str) -> (Vim, String, usize) {
        let mut vim = Vim {
            mode: Mode::Normal,
            ..Vim::default()
        };
        let mut buffer = text.to_owned();
        let mut cursor = at;
        for c in keys.chars() {
            let key = KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
            if vim.mode == Mode::Insert {
                buffer.insert(cursor, c);
                cursor += c.len_utf8();
            } else {
                vim.normal_key(&key, &mut buffer, &mut cursor);
            }
        }
        (vim, buffer, cursor)
    }

    fn state(text: &str, at: usize, keys: &str) -> (String, usize) {
        let (_, buffer, cursor) = run(text, at, keys);
        (buffer, cursor)
    }

    #[test]
    fn motions() {
        let text = "foo bar.baz  qux";
        assert_eq!(state(text, 0, "w").1, 4);
        assert_eq!(state(text, 0, "ww").1, 7);
        assert_eq!(state(text, 0, "3w").1, 8);
        assert_eq!(state(text, 0, "e").1, 2);
        assert_eq!(state(text, 0, "ee").1, 6);
        assert_eq!(state(text, 13, "b").1, 8);
        assert_eq!(state(text, 5, "$").1, 15);
        assert_eq!(state(text, 5, "0").1, 0);
        assert_eq!(state("  hi", 3, "^").1, 2);
        assert_eq!(state(text, 0, "l").1, 1);
        assert_eq!(state(text, 0, "5l").1, 5);
        assert_eq!(state(text, 0, "h").1, 0);
        assert_eq!(state(text, 15, "l").1, 15, "l stops on the last char");
    }

    #[test]
    fn multiline_movement_and_history() {
        let text = "one\ntwo\nthree";
        assert_eq!(state(text, 1, "j").1, 5);
        assert_eq!(state(text, 5, "k").1, 1);
        assert_eq!(state(text, 1, "G").1, 8);
        assert_eq!(state(text, 9, "gg").1, 0);
        assert_eq!(state(text, 0, "2G").1, 4);
        let mut vim = Vim {
            mode: Mode::Normal,
            ..Vim::default()
        };
        let mut buffer = text.to_owned();
        let mut cursor = 1;
        let k = KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE);
        assert_eq!(
            vim.normal_key(&k, &mut buffer, &mut cursor),
            Effect::HistoryPrev
        );
        cursor = 9;
        let j = KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE);
        assert_eq!(
            vim.normal_key(&j, &mut buffer, &mut cursor),
            Effect::HistoryNext
        );
    }

    #[test]
    fn inserting() {
        assert_eq!(state("bc", 0, "iA"), ("Abc".into(), 1));
        assert_eq!(state("bc", 0, "aX"), ("bXc".into(), 2));
        assert_eq!(state("  bc", 3, "IX"), ("  Xbc".into(), 3));
        assert_eq!(state("bc", 0, "AX"), ("bcX".into(), 3));
        assert_eq!(state("a\nb", 0, "oX"), ("a\nX\nb".into(), 3));
        assert_eq!(state("a\nb", 2, "OX"), ("a\nX\nb".into(), 3));
    }

    #[test]
    fn deleting() {
        assert_eq!(state("abc", 1, "x"), ("ac".into(), 1));
        assert_eq!(state("abc", 2, "x"), ("ab".into(), 1));
        assert_eq!(state("abc", 2, "X"), ("ac".into(), 1));
        assert_eq!(state("abcd", 0, "2x"), ("cd".into(), 0));
        assert_eq!(state("foo bar baz", 4, "D"), ("foo ".into(), 3));
        assert_eq!(state("foo bar baz", 0, "dw"), ("bar baz".into(), 0));
        assert_eq!(state("foo bar baz", 0, "2dw"), ("baz".into(), 0));
        assert_eq!(state("foo bar baz", 0, "d2w"), ("baz".into(), 0));
        assert_eq!(state("foo bar", 4, "dw"), ("foo ".into(), 3));
        assert_eq!(state("foo bar", 4, "db"), ("bar".into(), 0));
        assert_eq!(state("foo bar", 4, "d$"), ("foo ".into(), 3));
        assert_eq!(state("one\ntwo\nthree", 5, "dd"), ("one\nthree".into(), 4));
        assert_eq!(state("one\ntwo\nthree", 9, "dd"), ("one\ntwo".into(), 4));
        assert_eq!(state("one\ntwo\nthree", 0, "2dd"), ("three".into(), 0));
        assert_eq!(state("only", 2, "dd"), ("".into(), 0));
    }

    #[test]
    fn changing() {
        let (vim, buffer, cursor) = run("foo bar", 0, "cwX");
        assert_eq!(
            (buffer.as_str(), cursor, vim.mode),
            ("X bar", 1, Mode::Insert)
        );
        assert_eq!(state("foo bar", 4, "CX"), ("foo X".into(), 5));
        assert_eq!(state("a\nfoo\nb", 3, "ccX"), ("a\nX\nb".into(), 3));
        assert_eq!(state("abc", 1, "rX"), ("aXc".into(), 1));
        assert_eq!(state("abc", 0, "2rX"), ("XXc".into(), 0));
        assert_eq!(state("abc", 2, "2rX"), ("abc".into(), 2));
    }

    #[test]
    fn yank_put_and_undo() {
        assert_eq!(state("one\ntwo", 0, "yyjp"), ("one\ntwo\none".into(), 8));
        assert_eq!(state("one\ntwo", 4, "yyP"), ("one\ntwo\ntwo".into(), 4));
        assert_eq!(state("one\ntwo", 0, "ddp"), ("two\none".into(), 4));
        assert_eq!(state("abc", 0, "xp"), ("bac".into(), 1));
        assert_eq!(state("abc", 1, "xP"), ("abc".into(), 1));
        assert_eq!(state("foo bar", 0, "dwu"), ("foo bar".into(), 0));
        assert_eq!(state("abc", 0, "xxuu"), ("abc".into(), 0));
        assert_eq!(state("abc", 0, "u"), ("abc".into(), 0));
    }

    #[test]
    fn insert_session_is_one_undo_step() {
        let mut vim = Vim::default();
        let mut buffer = String::from("ab");
        let mut cursor = 2;
        vim.enter_normal(&buffer, &mut cursor);
        assert_eq!(cursor, 1);
        let key = |c| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
        vim.normal_key(&key('A'), &mut buffer, &mut cursor);
        assert_eq!(vim.mode, Mode::Insert);
        buffer.push_str("cd");
        cursor = buffer.len();
        vim.enter_normal(&buffer, &mut cursor);
        vim.normal_key(&key('u'), &mut buffer, &mut cursor);
        assert_eq!(buffer, "ab");
        // Entering and leaving insert without typing leaves no undo step.
        vim.normal_key(&key('i'), &mut buffer, &mut cursor);
        vim.enter_normal(&buffer, &mut cursor);
        assert!(vim.undo.is_empty());
    }

    #[test]
    fn escape_enter_and_modifiers() {
        let mut vim = Vim {
            mode: Mode::Normal,
            ..Vim::default()
        };
        let mut buffer = String::from("hi");
        let mut cursor = 0;
        let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        let d = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE);
        vim.normal_key(&d, &mut buffer, &mut cursor);
        assert_eq!(
            vim.normal_key(&esc, &mut buffer, &mut cursor),
            Effect::Handled
        );
        assert_eq!(
            vim.normal_key(&esc, &mut buffer, &mut cursor),
            Effect::Escape
        );
        let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(
            vim.normal_key(&enter, &mut buffer, &mut cursor),
            Effect::Submit
        );
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(
            vim.normal_key(&ctrl_c, &mut buffer, &mut cursor),
            Effect::Unhandled
        );
        let left = KeyEvent::new(KeyCode::Left, KeyModifiers::NONE);
        assert_eq!(
            vim.normal_key(&left, &mut buffer, &mut cursor),
            Effect::Unhandled
        );
        assert_eq!(buffer, "hi");
    }

    #[test]
    fn unicode_is_char_safe() {
        assert_eq!(state("héllo wörld", 0, "x"), ("éllo wörld".into(), 0));
        assert_eq!(state("héllo", 0, "l").1, 1);
        assert_eq!(state("héllo", 0, "ll").1, 3);
        assert_eq!(state("日本 語", 0, "w").1, 7);
        assert_eq!(state("日本", 0, "$").1, 3);
    }
}
