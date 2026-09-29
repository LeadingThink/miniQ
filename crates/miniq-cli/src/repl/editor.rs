//! Inline line editor state: buffer, cursor, history and completion.
//!
//! The editor is a pure state machine so it can be unit tested without a TTY.
//! `repl::mod` feeds it crossterm key events and renders `Editor::view`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use unicode_width::UnicodeWidthStr;

pub const HISTORY_LIMIT: usize = 1000;

/// Result of feeding one key to the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Nothing observable for the caller besides a redraw.
    Redraw,
    /// The user submitted the buffer.
    Submit(String),
    /// Tab pressed with no completion available (used for steer while running).
    Tab,
    /// Shift+Tab (permission mode cycle).
    BackTab,
    /// Escape with nothing to dismiss.
    Escape,
    /// Ctrl+C.
    Interrupt,
    /// Ctrl+D on an empty buffer.
    Eof,
    /// Ctrl+L.
    ClearScreen,
    /// Ctrl+G: open the external editor.
    External,
}

#[derive(Debug, Clone)]
struct Search {
    query: String,
    /// Index into history of the current match.
    matched: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Menu {
    pub items: Vec<(String, String)>,
    pub selected: usize,
    /// Byte range in the buffer replaced by the selected item.
    start: usize,
    end: usize,
}

#[derive(Debug)]
pub struct Editor {
    buffer: String,
    /// Byte offset into `buffer`, always on a char boundary.
    cursor: usize,
    history: Vec<String>,
    /// Position while browsing history; `None` means editing the draft.
    browsing: Option<usize>,
    draft: String,
    search: Option<Search>,
    pub menu: Option<Menu>,
    history_path: Option<PathBuf>,
    commands: Vec<(String, String)>,
    root: PathBuf,
    files: Option<Vec<String>>,
}

pub struct View {
    /// Rendered prompt + buffer lines (without colors).
    pub lines: Vec<String>,
    /// Cursor (row, column) relative to the first line.
    pub cursor: (usize, usize),
}

impl Editor {
    pub fn new(commands: Vec<(String, String)>, root: PathBuf) -> Self {
        Self {
            buffer: String::new(),
            cursor: 0,
            history: Vec::new(),
            browsing: None,
            draft: String::new(),
            search: None,
            menu: None,
            history_path: None,
            commands,
            root,
            files: None,
        }
    }

    /// Enable persistent history stored at `path`.
    pub fn with_history(mut self, path: Option<PathBuf>) -> Self {
        if let Some(path) = &path {
            self.history = load_history(path);
        }
        self.history_path = path;
        self
    }

    pub fn buffer(&self) -> &str {
        &self.buffer
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    #[cfg(test)]
    pub fn history(&self) -> &[String] {
        &self.history
    }

    pub fn set_buffer(&mut self, text: &str) {
        self.buffer = text.to_string();
        self.cursor = self.buffer.len();
        self.menu = None;
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.cursor = 0;
        self.browsing = None;
        self.search = None;
        self.menu = None;
    }

    pub fn searching(&self) -> bool {
        self.search.is_some()
    }

    /// Record a submitted entry; sensitive commands are never stored.
    pub fn remember(&mut self, entry: &str) {
        let entry = entry.trim_end();
        if entry.trim().is_empty() || sensitive(entry) {
            return;
        }
        if self.history.last().map(String::as_str) == Some(entry) {
            return;
        }
        self.history.push(entry.to_string());
        if self.history.len() > HISTORY_LIMIT {
            let excess = self.history.len() - HISTORY_LIMIT;
            self.history.drain(..excess);
        }
        if let Some(path) = &self.history_path {
            let _ = save_history(path, &self.history);
        }
    }

    pub fn insert(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        self.buffer.insert_str(self.cursor, &text);
        self.cursor += text.len();
        self.browsing = None;
        self.refresh_menu();
    }

    pub fn key(&mut self, key: KeyEvent) -> Action {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);

        if self.search.is_some() {
            return self.search_key(key, ctrl);
        }
        if self.menu.is_some() {
            if let Some(action) = self.menu_key(key) {
                return action;
            }
        }

        match key.code {
            // Raw mode reports a bare LF as Ctrl+J; scripts and PTY tests submit with it.
            KeyCode::Char('j') if ctrl => {
                self.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            }
            KeyCode::Enter => {
                if shift || alt {
                    self.insert("\n");
                    return Action::Redraw;
                }
                if self.buffer[..self.cursor].ends_with('\\') {
                    self.cursor -= 1;
                    self.buffer.remove(self.cursor);
                    self.insert("\n");
                    return Action::Redraw;
                }
                let text = std::mem::take(&mut self.buffer);
                self.cursor = 0;
                self.browsing = None;
                self.menu = None;
                Action::Submit(text)
            }
            KeyCode::Char('c') if ctrl => Action::Interrupt,
            KeyCode::Char('d') if ctrl => {
                if self.buffer.is_empty() {
                    Action::Eof
                } else {
                    self.delete_forward();
                    Action::Redraw
                }
            }
            KeyCode::Char('l') if ctrl => Action::ClearScreen,
            KeyCode::Char('g') if ctrl => Action::External,
            KeyCode::Char('r') if ctrl => {
                self.search = Some(Search {
                    query: String::new(),
                    matched: None,
                });
                Action::Redraw
            }
            KeyCode::Char('a') if ctrl => {
                self.cursor = self.line_start();
                Action::Redraw
            }
            KeyCode::Char('e') if ctrl => {
                self.cursor = self.line_end();
                Action::Redraw
            }
            KeyCode::Char('k') if ctrl => {
                let end = self.line_end();
                if end == self.cursor && end < self.buffer.len() {
                    self.buffer.remove(self.cursor);
                } else {
                    self.buffer.replace_range(self.cursor..end, "");
                }
                self.refresh_menu();
                Action::Redraw
            }
            KeyCode::Char('u') if ctrl => {
                let start = self.line_start();
                self.buffer.replace_range(start..self.cursor, "");
                self.cursor = start;
                self.refresh_menu();
                Action::Redraw
            }
            KeyCode::Char('w') if ctrl => {
                let start = self.word_left();
                self.buffer.replace_range(start..self.cursor, "");
                self.cursor = start;
                self.refresh_menu();
                Action::Redraw
            }
            KeyCode::Char('b') if alt => {
                self.cursor = self.word_left();
                Action::Redraw
            }
            KeyCode::Char('f') if alt => {
                self.cursor = self.word_right();
                Action::Redraw
            }
            KeyCode::Left if alt || ctrl => {
                self.cursor = self.word_left();
                Action::Redraw
            }
            KeyCode::Right if alt || ctrl => {
                self.cursor = self.word_right();
                Action::Redraw
            }
            KeyCode::Char('b') if ctrl => {
                self.left();
                Action::Redraw
            }
            KeyCode::Char('f') if ctrl => {
                self.right();
                Action::Redraw
            }
            KeyCode::Char(c) if !ctrl => {
                let mut tmp = [0u8; 4];
                self.insert(c.encode_utf8(&mut tmp));
                Action::Redraw
            }
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.left();
                    self.buffer.remove(self.cursor);
                }
                self.refresh_menu();
                Action::Redraw
            }
            KeyCode::Delete => {
                self.delete_forward();
                Action::Redraw
            }
            KeyCode::Left => {
                self.left();
                Action::Redraw
            }
            KeyCode::Right => {
                self.right();
                Action::Redraw
            }
            KeyCode::Home => {
                self.cursor = self.line_start();
                Action::Redraw
            }
            KeyCode::End => {
                self.cursor = self.line_end();
                Action::Redraw
            }
            KeyCode::Up => {
                if self.buffer[..self.cursor].contains('\n') {
                    self.vertical(-1);
                } else {
                    self.history_prev();
                }
                Action::Redraw
            }
            KeyCode::Down => {
                if self.buffer[self.cursor..].contains('\n') {
                    self.vertical(1);
                } else {
                    self.history_next();
                }
                Action::Redraw
            }
            KeyCode::Tab => {
                if self.complete() {
                    Action::Redraw
                } else {
                    Action::Tab
                }
            }
            KeyCode::BackTab => Action::BackTab,
            KeyCode::Esc => Action::Escape,
            _ => Action::Redraw,
        }
    }

    fn menu_key(&mut self, key: KeyEvent) -> Option<Action> {
        let menu = self.menu.as_mut()?;
        match key.code {
            KeyCode::Up => {
                menu.selected = (menu.selected + menu.items.len() - 1) % menu.items.len();
                Some(Action::Redraw)
            }
            KeyCode::Down => {
                menu.selected = (menu.selected + 1) % menu.items.len();
                Some(Action::Redraw)
            }
            KeyCode::Tab => {
                self.accept_menu();
                Some(Action::Redraw)
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                // Enter accepts a file completion; for commands it accepts and submits
                // only if the typed text is not already the exact command.
                let menu = self.menu.as_ref()?;
                let item = menu.items[menu.selected].0.clone();
                let typed = self.buffer[menu.start..menu.end].to_string();
                if typed == item {
                    self.menu = None;
                    return None;
                }
                let command = item.starts_with('/');
                self.accept_menu();
                if command {
                    self.menu = None;
                    return None;
                }
                Some(Action::Redraw)
            }
            KeyCode::Esc => {
                self.menu = None;
                Some(Action::Redraw)
            }
            _ => None,
        }
    }

    fn accept_menu(&mut self) {
        if let Some(menu) = self.menu.take() {
            let item = &menu.items[menu.selected].0;
            let mut replacement = item.clone();
            if !replacement.ends_with('/') {
                replacement.push(' ');
            }
            self.buffer
                .replace_range(menu.start..menu.end, &replacement);
            self.cursor = menu.start + replacement.len();
            if item.ends_with('/') {
                self.refresh_menu();
            }
        }
    }

    fn search_key(&mut self, key: KeyEvent, ctrl: bool) -> Action {
        let Some(search) = self.search.as_mut() else {
            return Action::Redraw;
        };
        match key.code {
            KeyCode::Char('r') if ctrl => {
                let before = search.matched.unwrap_or(self.history.len());
                search.matched = find(&self.history, &search.query, before);
                if search.matched.is_none() {
                    search.matched = find(&self.history, &search.query, before + 1);
                }
            }
            KeyCode::Char('c' | 'g') if ctrl => {
                self.search = None;
            }
            KeyCode::Esc => {
                self.search = None;
            }
            KeyCode::Char(c) if !ctrl => {
                search.query.push(c);
                search.matched = find(&self.history, &search.query, self.history.len());
            }
            KeyCode::Backspace => {
                search.query.pop();
                search.matched = find(&self.history, &search.query, self.history.len());
            }
            _ => {
                if let Some(index) = search.matched {
                    let entry = self.history[index].clone();
                    self.set_buffer(&entry);
                }
                self.search = None;
                if key.code == KeyCode::Enter {
                    return self.key(key);
                }
            }
        }
        Action::Redraw
    }

    fn delete_forward(&mut self) {
        if self.cursor < self.buffer.len() {
            self.buffer.remove(self.cursor);
        }
        self.refresh_menu();
    }

    fn left(&mut self) {
        if let Some(c) = self.buffer[..self.cursor].chars().next_back() {
            self.cursor -= c.len_utf8();
        }
    }

    fn right(&mut self) {
        if let Some(c) = self.buffer[self.cursor..].chars().next() {
            self.cursor += c.len_utf8();
        }
    }

    fn line_start(&self) -> usize {
        self.buffer[..self.cursor].rfind('\n').map_or(0, |i| i + 1)
    }

    fn line_end(&self) -> usize {
        self.buffer[self.cursor..]
            .find('\n')
            .map_or(self.buffer.len(), |i| self.cursor + i)
    }

    fn word_left(&self) -> usize {
        let head = &self.buffer[..self.cursor];
        let trimmed = head.trim_end_matches(|c: char| !c.is_alphanumeric());
        trimmed
            .rfind(|c: char| !c.is_alphanumeric())
            .map_or(0, |i| {
                i + trimmed[i..].chars().next().map_or(1, char::len_utf8)
            })
    }

    fn word_right(&self) -> usize {
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

    fn vertical(&mut self, direction: i32) {
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

    fn history_prev(&mut self) {
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

    fn history_next(&mut self) {
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

    /// Recompute the popup menu for the token under the cursor.
    pub fn refresh_menu(&mut self) {
        self.menu = self.candidates(false);
    }

    fn complete(&mut self) -> bool {
        match self.candidates(true) {
            Some(menu) if menu.items.len() == 1 => {
                self.menu = Some(menu);
                self.accept_menu();
                true
            }
            Some(menu) => {
                self.menu = Some(menu);
                true
            }
            None => false,
        }
    }

    fn candidates(&mut self, explicit: bool) -> Option<Menu> {
        let head = &self.buffer[..self.cursor];
        // Slash commands: only when the whole buffer is a single `/word`.
        if head.starts_with('/') && !head.contains(char::is_whitespace) {
            let items: Vec<_> = self
                .commands
                .iter()
                .filter(|(name, _)| name.starts_with(head))
                .cloned()
                .collect();
            if items.is_empty() {
                return None;
            }
            return Some(Menu {
                items,
                selected: 0,
                start: 0,
                end: self.cursor,
            });
        }
        let start = head.rfind(char::is_whitespace).map_or(0, |i| {
            i + head[i..].chars().next().map_or(1, char::len_utf8)
        });
        let token = &head[start..];
        if let Some(query) = token.strip_prefix('@') {
            let query = query.to_string();
            let files = self.files();
            let items: Vec<_> = fuzzy(files, &query, 8)
                .into_iter()
                .map(|path| (format!("@{path}"), String::new()))
                .collect();
            if items.is_empty() || (!explicit && query.is_empty() && items.len() > 8) {
                return None;
            }
            return Some(Menu {
                items,
                selected: 0,
                start,
                end: self.cursor,
            });
        }
        None
    }

    fn files(&mut self) -> &[String] {
        if self.files.is_none() {
            self.files = Some(list_files(&self.root, 20_000));
        }
        self.files.as_deref().unwrap_or_default()
    }

    /// Lines to display (prompt on the first line, `… ` continuation prompts).
    pub fn view(&self, prompt: &str) -> View {
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
        let continuation = " ".repeat(UnicodeWidthStr::width(prompt).saturating_sub(2)) + "… ";
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

fn find(history: &[String], query: &str, before: usize) -> Option<usize> {
    if query.is_empty() {
        return None;
    }
    history[..before.min(history.len())]
        .iter()
        .rposition(|entry| entry.contains(query))
}

/// Commands whose arguments may contain secrets are never stored in history.
pub fn sensitive(entry: &str) -> bool {
    let first = entry.split_whitespace().next().unwrap_or_default();
    matches!(first, "/login" | "/logout" | "/key" | "/apikey" | "/token")
        || entry.to_ascii_lowercase().contains("api_key=")
}

pub fn load_history(path: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut entries: Vec<String> = text
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<String>(line).ok())
        .collect();
    if entries.len() > HISTORY_LIMIT {
        entries.drain(..entries.len() - HISTORY_LIMIT);
    }
    entries
}

pub fn save_history(path: &Path, entries: &[String]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("tmp");
    {
        let mut file = open_private(&temp)?;
        for entry in entries.iter().rev().take(HISTORY_LIMIT).rev() {
            let line = serde_json::to_string(entry).unwrap_or_default();
            writeln!(file, "{line}")?;
        }
    }
    fs::rename(temp, path)
}

#[cfg(unix)]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    fs::File::create(path)
}

/// Files under `root`, respecting .gitignore, as `/`-separated relative paths.
pub fn list_files(root: &Path, limit: usize) -> Vec<String> {
    let mut files = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(true)
        .max_depth(Some(12))
        .build()
        .flatten()
    {
        if files.len() >= limit {
            break;
        }
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let mut text = relative.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_some_and(|t| t.is_dir()) {
            text.push('/');
        }
        files.push(text);
    }
    files.sort();
    files
}

/// Subsequence fuzzy match; prefers basename matches and shorter paths.
pub fn fuzzy(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let query = query.to_lowercase();
    let mut scored: Vec<(i64, &String)> = files
        .iter()
        .filter_map(|path| score(path, &query).map(|s| (s, path)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, p)| p.clone())
        .collect()
}

fn score(path: &str, query: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(-(path.len() as i64));
    }
    let lower = path.to_lowercase();
    let mut chars = lower.char_indices();
    let mut last = None;
    let mut gaps = 0i64;
    for q in query.chars() {
        let (index, _) = chars.find(|(_, c)| *c == q)?;
        if let Some(last) = last {
            gaps += (index - last - 1) as i64;
        }
        last = Some(index);
    }
    let base = lower
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(&lower);
    let mut score = 1000 - gaps * 3 - lower.len() as i64;
    if base.contains(query) {
        score += 500;
    }
    if lower.contains(query) {
        score += 200;
    }
    Some(score)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    fn editor() -> Editor {
        Editor::new(
            vec![
                ("/model".into(), "switch model".into()),
                ("/mcp".into(), "list MCP servers".into()),
                ("/help".into(), "help".into()),
            ],
            PathBuf::from("."),
        )
    }

    fn typed(editor: &mut Editor, text: &str) {
        for c in text.chars() {
            editor.key(key(KeyCode::Char(c)));
        }
    }

    #[test]
    fn typing_and_submit() {
        let mut e = editor();
        typed(&mut e, "hello");
        assert_eq!(e.key(key(KeyCode::Enter)), Action::Submit("hello".into()));
        assert!(e.is_empty());
    }

    #[test]
    fn multiline_with_shift_enter_and_backslash() {
        let mut e = editor();
        typed(&mut e, "a");
        e.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
        typed(&mut e, "b\\");
        assert_eq!(e.key(key(KeyCode::Enter)), Action::Redraw);
        typed(&mut e, "c");
        assert_eq!(e.key(key(KeyCode::Enter)), Action::Submit("a\nb\nc".into()));
    }

    #[test]
    fn paste_normalizes_newlines() {
        let mut e = editor();
        e.insert("x\r\ny");
        assert_eq!(e.buffer(), "x\ny");
        let view = e.view("miniq> ");
        assert_eq!(view.lines.len(), 2);
        assert_eq!(view.cursor, (1, 8));
    }

    #[test]
    fn emacs_keys() {
        let mut e = editor();
        typed(&mut e, "one two three");
        e.key(ctrl('w'));
        assert_eq!(e.buffer(), "one two ");
        e.key(ctrl('a'));
        e.key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::ALT));
        assert_eq!(e.cursor, 3);
        e.key(ctrl('k'));
        assert_eq!(e.buffer(), "one");
        e.key(ctrl('u'));
        assert_eq!(e.buffer(), "");
        assert_eq!(e.key(ctrl('d')), Action::Eof);
    }

    #[test]
    fn unicode_cursor() {
        let mut e = editor();
        typed(&mut e, "你好");
        e.key(key(KeyCode::Left));
        e.key(key(KeyCode::Backspace));
        assert_eq!(e.buffer(), "好");
        assert_eq!(e.view("> ").cursor, (0, 2));
    }

    #[test]
    fn history_browse_and_search() {
        let mut e = editor();
        e.remember("first");
        e.remember("second");
        e.remember("/login secret");
        assert_eq!(e.history(), ["first", "second"]);
        typed(&mut e, "dra");
        e.key(key(KeyCode::Up));
        assert_eq!(e.buffer(), "second");
        e.key(key(KeyCode::Up));
        assert_eq!(e.buffer(), "first");
        e.key(key(KeyCode::Down));
        e.key(key(KeyCode::Down));
        assert_eq!(e.buffer(), "dra");
        e.clear();
        e.key(ctrl('r'));
        typed(&mut e, "fir");
        assert!(e.view("> ").lines[0].contains("first"));
        assert_eq!(e.key(key(KeyCode::Enter)), Action::Submit("first".into()));
    }

    #[test]
    fn history_persists_with_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cli_history");
        let mut e = editor().with_history(Some(path.clone()));
        for i in 0..(HISTORY_LIMIT + 5) {
            e.remember(&format!("entry {i}"));
        }
        e.remember("multi\nline");
        let loaded = load_history(&path);
        assert_eq!(loaded.len(), HISTORY_LIMIT);
        assert_eq!(loaded.last().unwrap(), "multi\nline");
    }

    #[test]
    fn slash_menu_and_tab() {
        let mut e = editor();
        typed(&mut e, "/m");
        let menu = e.menu.clone().unwrap();
        assert_eq!(menu.items.len(), 2);
        e.key(key(KeyCode::Down));
        e.key(key(KeyCode::Tab));
        assert_eq!(e.buffer(), "/mcp ");
        e.clear();
        typed(&mut e, "/he");
        e.key(key(KeyCode::Tab));
        assert_eq!(e.buffer(), "/help ");
        e.clear();
        typed(&mut e, "/model");
        assert_eq!(e.key(key(KeyCode::Enter)), Action::Submit("/model".into()));
    }

    #[test]
    fn tab_without_completion_is_reported() {
        let mut e = editor();
        typed(&mut e, "plain");
        assert_eq!(e.key(key(KeyCode::Tab)), Action::Tab);
    }

    #[test]
    fn fuzzy_file_matching() {
        let files = vec![
            "src/main.rs".to_string(),
            "src/repl/editor.rs".to_string(),
            "README.md".to_string(),
        ];
        assert_eq!(fuzzy(&files, "edtr", 5), vec!["src/repl/editor.rs"]);
        assert_eq!(fuzzy(&files, "main", 5)[0], "src/main.rs");
        assert!(fuzzy(&files, "zzz", 5).is_empty());
    }

    #[test]
    fn at_completion_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
        fs::create_dir(dir.path().join("target")).unwrap();
        fs::write(dir.path().join("target/out.rs"), "").unwrap();
        fs::write(dir.path().join("lib.rs"), "").unwrap();
        let files = list_files(dir.path(), 100);
        assert!(files.contains(&"lib.rs".to_string()));
        assert!(!files.iter().any(|f| f.starts_with("target")));

        let mut e = Editor::new(Vec::new(), dir.path().to_path_buf());
        typed(&mut e, "see @li");
        e.key(key(KeyCode::Tab));
        assert_eq!(e.buffer(), "see @lib.rs ");
    }
}
