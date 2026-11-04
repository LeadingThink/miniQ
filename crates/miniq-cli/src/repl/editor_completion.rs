//! Command and file completion, with all results available through paging.
use super::*;

impl Editor {
    pub(super) fn menu_key(&mut self, key: KeyEvent) -> Option<Action> {
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

    pub(super) fn accept_menu(&mut self) {
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

    pub(super) fn search_key(&mut self, key: KeyEvent, ctrl: bool) -> Action {
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

    /// Recompute the popup menu for the token under the cursor.
    pub fn refresh_menu(&mut self) {
        self.menu = self.candidates();
    }

    pub(super) fn complete(&mut self) -> bool {
        match self.candidates() {
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

    pub(super) fn candidates(&mut self) -> Option<Menu> {
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
        if let Some(mention) = super::super::attachments::mentions(head)
            .last()
            .filter(|mention| mention.end == head.len())
        {
            let start = mention.start;
            let query = mention.path.replace('\\', "/");
            let files = self.files();
            let items: Vec<_> = fuzzy(files, &query)
                .into_iter()
                .map(|path| (super::super::attachments::quote(&path), String::new()))
                .collect();
            if items.is_empty() {
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

    pub(super) fn files(&mut self) -> &[String] {
        if self.files.is_none() {
            self.files = Some(list_files(&self.root));
        }
        self.files.as_deref().unwrap_or_default()
    }
}

/// Files under `root`, respecting .gitignore, as `/`-separated relative paths.
pub fn list_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(true)
        .build()
        .flatten()
    {
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
pub fn fuzzy(files: &[String], query: &str) -> Vec<String> {
    let query = query.to_lowercase();
    let mut scored: Vec<(i64, &String)> = files
        .iter()
        .filter_map(|path| score(path, &query).map(|s| (s, path)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    scored.into_iter().map(|(_, p)| p.clone()).collect()
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
