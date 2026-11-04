//! Inline line editor state: buffer, cursor, history and completion.
//!
//! The editor is a pure state machine so it can be unit tested without a TTY.
//! `repl::mod` feeds it crossterm key events and renders `Editor::view`.

use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use unicode_width::UnicodeWidthStr;

use super::keymap::{Command, KeySpec, Keymap};
use super::vim::{Effect, Mode, Vim};

#[path = "editor_completion.rs"]
mod completion;
#[path = "editor_history.rs"]
mod history;
#[path = "editor_interaction.rs"]
mod interaction;
#[path = "editor_movement.rs"]
mod movement;
#[cfg(test)]
use completion::{fuzzy, list_files};
use history::{find, load_history, save_history, sensitive};

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
    pub folded: bool,
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
    keymap: Keymap,
    /// Vim emulation state; `None` in emacs mode.
    vim: Option<Vim>,
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
            folded: false,
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
            keymap: Keymap::default(),
            vim: None,
        }
    }

    /// Use `keymap` instead of the built-in bindings.
    pub fn with_keymap(mut self, keymap: Keymap) -> Self {
        self.keymap = keymap;
        self
    }

    pub fn keymap(&self) -> &Keymap {
        &self.keymap
    }

    /// Enable or disable vim emulation (starts in INSERT mode).
    pub fn set_vim(&mut self, enabled: bool) {
        self.vim = enabled.then(Vim::default);
    }

    pub fn vim_enabled(&self) -> bool {
        self.vim.is_some()
    }

    /// `-- INSERT --` / `-- NORMAL --` when vim emulation is on.
    pub fn mode_indicator(&self) -> Option<&'static str> {
        self.vim.as_ref().map(Vim::indicator)
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

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn set_cursor(&mut self, cursor: usize) {
        self.cursor = cursor.min(self.buffer.len());
        while !self.buffer.is_char_boundary(self.cursor) {
            self.cursor -= 1;
        }
    }

    pub fn set_root(&mut self, root: PathBuf) {
        self.root = root;
        self.files = None;
        self.menu = None;
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    #[cfg(test)]
    pub fn history(&self) -> &[String] {
        &self.history
    }

    pub fn set_buffer(&mut self, text: &str) {
        self.folded = false;
        self.buffer = text.to_string();
        self.cursor = self.buffer.len();
        self.menu = None;
    }

    pub fn clear(&mut self) {
        self.folded = false;
        self.buffer.clear();
        self.cursor = 0;
        self.browsing = None;
        self.search = None;
        self.menu = None;
        if let Some(vim) = self.vim.as_mut() {
            vim.reset();
        }
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
        self.folded = false;
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        if self.search.is_some() {
            return self.search_key(key, ctrl);
        }
        if self.menu.is_some() {
            if let Some(action) = self.menu_key(key) {
                return action;
            }
        }
        if let Some(vim) = self.vim.as_mut() {
            if vim.mode == Mode::Normal {
                let effect = vim.normal_key(&key, &mut self.buffer, &mut self.cursor);
                if effect != Effect::Unhandled {
                    self.menu = None;
                }
                match effect {
                    Effect::Handled => {
                        self.browsing = None;
                        return Action::Redraw;
                    }
                    Effect::Unhandled => {}
                    Effect::Submit => return self.run(Command::Submit),
                    Effect::HistoryPrev => {
                        self.history_prev();
                        self.normal_cursor();
                        return Action::Redraw;
                    }
                    Effect::HistoryNext => {
                        self.history_next();
                        self.normal_cursor();
                        return Action::Redraw;
                    }
                    Effect::Escape => return Action::Escape,
                }
            }
        }

        let spec = KeySpec::from_event(&key);
        let command = self.keymap.lookup_spec(spec).or_else(|| {
            // Keep modified navigation keys (Shift+Left, Alt+Up, ...) working like
            // the plain key unless they are bound explicitly.
            let plain = !matches!(spec.code, KeyCode::Char(_)) && !spec.modifiers.is_empty();
            plain
                .then(|| KeySpec::from_event(&KeyEvent::new(key.code, KeyModifiers::NONE)))
                .and_then(|spec| self.keymap.lookup_spec(spec))
                .filter(|command| *command != Command::Complete)
        });
        if let Some(command) = command {
            return self.run(command);
        }
        match key.code {
            KeyCode::Char(c) if !ctrl => {
                let mut tmp = [0u8; 4];
                self.insert(c.encode_utf8(&mut tmp));
                Action::Redraw
            }
            _ => Action::Redraw,
        }
    }

    /// Execute a bound editor command.
    fn run(&mut self, command: Command) -> Action {
        match command {
            Command::Submit => {
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
                if let Some(vim) = self.vim.as_mut() {
                    vim.reset();
                }
                Action::Submit(text)
            }
            Command::Newline => {
                self.insert("\n");
                Action::Redraw
            }
            Command::Interrupt => Action::Interrupt,
            Command::Cancel => {
                if let Some(vim) = self.vim.as_mut() {
                    if vim.mode == Mode::Insert {
                        let empty = self.buffer.is_empty();
                        vim.enter_normal(&self.buffer, &mut self.cursor);
                        self.menu = None;
                        // On an empty prompt Esc still reaches the REPL (interrupt a turn).
                        return if empty {
                            Action::Escape
                        } else {
                            Action::Redraw
                        };
                    }
                }
                Action::Escape
            }
            Command::ClearLine => {
                self.buffer.clear();
                self.cursor = 0;
                self.browsing = None;
                self.menu = None;
                Action::Redraw
            }
            Command::Exit => {
                if self.buffer.is_empty() {
                    Action::Eof
                } else {
                    self.delete_forward();
                    Action::Redraw
                }
            }
            Command::ClearScreen => Action::ClearScreen,
            Command::ExternalEditor => Action::External,
            Command::HistorySearch => {
                self.search = Some(Search {
                    query: String::new(),
                    matched: None,
                });
                Action::Redraw
            }
            Command::LineStart => {
                self.cursor = self.line_start();
                Action::Redraw
            }
            Command::LineEnd => {
                self.cursor = self.line_end();
                Action::Redraw
            }
            Command::DeleteToLineEnd => {
                let end = self.line_end();
                if end == self.cursor && end < self.buffer.len() {
                    self.buffer.remove(self.cursor);
                } else {
                    self.buffer.replace_range(self.cursor..end, "");
                }
                self.refresh_menu();
                Action::Redraw
            }
            Command::DeleteToLineStart => {
                let start = self.line_start();
                self.buffer.replace_range(start..self.cursor, "");
                self.cursor = start;
                self.refresh_menu();
                Action::Redraw
            }
            Command::DeleteWordBack => {
                let start = self.word_left();
                self.buffer.replace_range(start..self.cursor, "");
                self.cursor = start;
                self.refresh_menu();
                Action::Redraw
            }
            Command::DeleteWordForward => {
                let end = self.word_right();
                self.buffer.replace_range(self.cursor..end, "");
                self.refresh_menu();
                Action::Redraw
            }
            Command::WordLeft => {
                self.cursor = self.word_left();
                Action::Redraw
            }
            Command::WordRight => {
                self.cursor = self.word_right();
                Action::Redraw
            }
            Command::CursorLeft => {
                self.left();
                Action::Redraw
            }
            Command::CursorRight => {
                self.right();
                Action::Redraw
            }
            Command::DeleteBack => {
                if self.cursor > 0 {
                    self.left();
                    self.buffer.remove(self.cursor);
                }
                self.refresh_menu();
                Action::Redraw
            }
            Command::DeleteForward => {
                self.delete_forward();
                Action::Redraw
            }
            Command::HistoryPrev => {
                if self.buffer[..self.cursor].contains('\n') {
                    self.vertical(-1);
                } else {
                    self.history_prev();
                }
                Action::Redraw
            }
            Command::HistoryNext => {
                if self.buffer[self.cursor..].contains('\n') {
                    self.vertical(1);
                } else {
                    self.history_next();
                }
                Action::Redraw
            }
            Command::Complete => {
                if self.complete() {
                    Action::Redraw
                } else {
                    Action::Tab
                }
            }
            Command::CycleMode => Action::BackTab,
        }
    }

    /// In NORMAL mode the cursor rests on a character, not past the line end.
    fn normal_cursor(&mut self) {
        let end = self.line_end();
        if self.cursor >= end && end > self.line_start() {
            self.left();
        }
    }
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
