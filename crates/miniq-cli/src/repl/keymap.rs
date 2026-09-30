//! Named editor actions and their key bindings (defaults plus `cli.json` overrides).

use std::collections::BTreeMap;
use std::fmt;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// An editor action that can be bound to keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Command {
    Submit,
    Newline,
    Interrupt,
    Cancel,
    ClearLine,
    CursorLeft,
    CursorRight,
    WordLeft,
    WordRight,
    LineStart,
    LineEnd,
    DeleteBack,
    DeleteForward,
    DeleteWordBack,
    DeleteWordForward,
    DeleteToLineEnd,
    DeleteToLineStart,
    HistoryPrev,
    HistoryNext,
    HistorySearch,
    Complete,
    CycleMode,
    ClearScreen,
    ExternalEditor,
    Exit,
}

/// Every action with its `cli.json` name and default key specs, in display order.
const DEFAULTS: &[(Command, &str, &[&str])] = &[
    (Command::Submit, "submit", &["enter", "ctrl+j"]),
    (Command::Newline, "newline", &["shift+enter", "alt+enter"]),
    (Command::Interrupt, "interrupt", &["ctrl+c"]),
    (Command::Cancel, "cancel", &["esc"]),
    (Command::ClearLine, "clearLine", &[]),
    (Command::CursorLeft, "cursorLeft", &["left", "ctrl+b"]),
    (Command::CursorRight, "cursorRight", &["right", "ctrl+f"]),
    (
        Command::WordLeft,
        "wordLeft",
        &["alt+b", "alt+left", "ctrl+left"],
    ),
    (
        Command::WordRight,
        "wordRight",
        &["alt+f", "alt+right", "ctrl+right"],
    ),
    (Command::LineStart, "lineStart", &["home", "ctrl+a"]),
    (Command::LineEnd, "lineEnd", &["end", "ctrl+e"]),
    (Command::DeleteBack, "deleteBack", &["backspace"]),
    (Command::DeleteForward, "deleteForward", &["delete"]),
    (Command::DeleteWordBack, "deleteWordBack", &["ctrl+w"]),
    (Command::DeleteWordForward, "deleteWordForward", &["alt+d"]),
    (Command::DeleteToLineEnd, "deleteToLineEnd", &["ctrl+k"]),
    (Command::DeleteToLineStart, "deleteToLineStart", &["ctrl+u"]),
    (Command::HistoryPrev, "historyPrev", &["up"]),
    (Command::HistoryNext, "historyNext", &["down"]),
    (Command::HistorySearch, "historySearch", &["ctrl+r"]),
    (Command::Complete, "complete", &["tab"]),
    (Command::CycleMode, "cycleMode", &["shift+tab"]),
    (Command::ClearScreen, "clearScreen", &["ctrl+l"]),
    (Command::ExternalEditor, "externalEditor", &["ctrl+g"]),
    (Command::Exit, "exit", &["ctrl+d"]),
];

/// Accepted aliases for action names (compared case-insensitively, `-`/`_` ignored).
const ALIASES: &[(&str, Command)] = &[
    ("escape", Command::Cancel),
    ("tab", Command::Complete),
    ("left", Command::CursorLeft),
    ("right", Command::CursorRight),
    ("home", Command::LineStart),
    ("end", Command::LineEnd),
    ("backspace", Command::DeleteBack),
    ("delete", Command::DeleteForward),
    ("killline", Command::DeleteToLineEnd),
    ("up", Command::HistoryPrev),
    ("down", Command::HistoryNext),
    ("search", Command::HistorySearch),
    ("editor", Command::ExternalEditor),
    ("eof", Command::Exit),
];

impl Command {
    pub fn name(self) -> &'static str {
        DEFAULTS
            .iter()
            .find(|(command, _, _)| *command == self)
            .map_or("?", |(_, name, _)| name)
    }

    /// Resolve a `cli.json` action name.
    pub fn from_name(name: &str) -> Option<Self> {
        let wanted = normalize_name(name);
        DEFAULTS
            .iter()
            .find(|(_, candidate, _)| normalize_name(candidate) == wanted)
            .map(|(command, _, _)| *command)
            .or_else(|| {
                ALIASES
                    .iter()
                    .find(|(alias, _)| *alias == wanted)
                    .map(|(_, command)| *command)
            })
    }
}

fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| *c != '-' && *c != '_')
        .flat_map(char::to_lowercase)
        .collect()
}

/// A single key with modifiers, normalized so that events and specs compare equal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeySpec {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

const MODIFIERS: KeyModifiers = KeyModifiers::CONTROL
    .union(KeyModifiers::ALT)
    .union(KeyModifiers::SHIFT)
    .union(KeyModifiers::META)
    .union(KeyModifiers::SUPER);

impl KeySpec {
    /// Parse `ctrl+shift+enter`, `alt+b`, `f5`, `ctrl++` ... (case-insensitive).
    pub fn parse(spec: &str) -> Result<Self, String> {
        let text = spec.trim().to_ascii_lowercase();
        if text.is_empty() {
            return Err("empty key spec".into());
        }
        let (mods, key) = if text == "+" {
            ("", "+")
        } else if let Some(rest) = text.strip_suffix("++") {
            (rest, "+")
        } else {
            match text.rsplit_once('+') {
                Some((mods, key)) => (mods, key),
                None => ("", text.as_str()),
            }
        };
        let mut modifiers = KeyModifiers::NONE;
        for part in mods
            .split('+')
            .filter(|p| !p.is_empty() || !mods.is_empty())
        {
            modifiers |= match part.trim() {
                "ctrl" | "control" => KeyModifiers::CONTROL,
                "alt" | "option" | "opt" => KeyModifiers::ALT,
                "shift" => KeyModifiers::SHIFT,
                "meta" => KeyModifiers::META,
                "super" | "cmd" | "command" => KeyModifiers::SUPER,
                "" => return Err(format!("invalid key spec `{spec}`")),
                other => return Err(format!("unknown modifier `{other}` in `{spec}`")),
            };
        }
        let code = match key.trim() {
            "enter" | "return" | "cr" => KeyCode::Enter,
            "tab" => KeyCode::Tab,
            "esc" | "escape" => KeyCode::Esc,
            "backspace" | "bs" => KeyCode::Backspace,
            "delete" | "del" => KeyCode::Delete,
            "up" => KeyCode::Up,
            "down" => KeyCode::Down,
            "left" => KeyCode::Left,
            "right" => KeyCode::Right,
            "home" => KeyCode::Home,
            "end" => KeyCode::End,
            "pageup" | "pgup" => KeyCode::PageUp,
            "pagedown" | "pgdn" | "pgdown" => KeyCode::PageDown,
            "space" => KeyCode::Char(' '),
            "" => return Err(format!("missing key in `{spec}`")),
            other => {
                if let Some(n) = other.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                    if (1..=12).contains(&n) {
                        KeyCode::F(n)
                    } else {
                        return Err(format!("unknown key `{other}` in `{spec}`"));
                    }
                } else {
                    let mut chars = other.chars();
                    match (chars.next(), chars.next()) {
                        (Some(c), None) => KeyCode::Char(c),
                        _ => return Err(format!("unknown key `{other}` in `{spec}`")),
                    }
                }
            }
        };
        Ok(Self::normalized(code, modifiers))
    }

    /// Normalize a terminal key event for lookup.
    pub fn from_event(key: &KeyEvent) -> Self {
        Self::normalized(key.code, key.modifiers)
    }

    fn normalized(code: KeyCode, modifiers: KeyModifiers) -> Self {
        let mut modifiers = modifiers & MODIFIERS;
        let code = match code {
            KeyCode::BackTab => {
                modifiers |= KeyModifiers::SHIFT;
                KeyCode::Tab
            }
            KeyCode::Char(c) if c.is_ascii_uppercase() => {
                modifiers |= KeyModifiers::SHIFT;
                KeyCode::Char(c.to_ascii_lowercase())
            }
            KeyCode::Char(c) => {
                // Shifted punctuation already encodes Shift in the character itself.
                if !c.is_alphabetic() {
                    modifiers -= KeyModifiers::SHIFT;
                }
                KeyCode::Char(c)
            }
            other => other,
        };
        Self { code, modifiers }
    }
}

impl fmt::Display for KeySpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (flag, name) in [
            (KeyModifiers::CONTROL, "ctrl"),
            (KeyModifiers::ALT, "alt"),
            (KeyModifiers::SHIFT, "shift"),
            (KeyModifiers::META, "meta"),
            (KeyModifiers::SUPER, "super"),
        ] {
            if self.modifiers.contains(flag) {
                write!(f, "{name}+")?;
            }
        }
        match self.code {
            KeyCode::Enter => f.write_str("enter"),
            KeyCode::Tab => f.write_str("tab"),
            KeyCode::Esc => f.write_str("esc"),
            KeyCode::Backspace => f.write_str("backspace"),
            KeyCode::Delete => f.write_str("delete"),
            KeyCode::Up => f.write_str("up"),
            KeyCode::Down => f.write_str("down"),
            KeyCode::Left => f.write_str("left"),
            KeyCode::Right => f.write_str("right"),
            KeyCode::Home => f.write_str("home"),
            KeyCode::End => f.write_str("end"),
            KeyCode::PageUp => f.write_str("pageup"),
            KeyCode::PageDown => f.write_str("pagedown"),
            KeyCode::Char(' ') => f.write_str("space"),
            KeyCode::Char(c) => write!(f, "{c}"),
            KeyCode::F(n) => write!(f, "f{n}"),
            other => write!(f, "{other:?}"),
        }
    }
}

/// Effective bindings: defaults, with user overrides replacing whole actions.
#[derive(Debug, Clone)]
pub struct Keymap {
    bindings: Vec<(Command, Vec<KeySpec>, bool)>,
}

impl Default for Keymap {
    fn default() -> Self {
        Self::new(&BTreeMap::new()).0
    }
}

impl Keymap {
    /// Build from defaults plus overrides (`action -> specs`). Returns warnings for
    /// unknown actions and invalid specs, which are ignored.
    pub fn new(overrides: &BTreeMap<String, Vec<String>>) -> (Self, Vec<String>) {
        let mut warnings = Vec::new();
        let mut bindings: Vec<(Command, Vec<KeySpec>, bool)> = DEFAULTS
            .iter()
            .map(|(command, _, specs)| {
                let keys = specs
                    .iter()
                    .map(|spec| KeySpec::parse(spec).expect("valid default key spec"))
                    .collect();
                (*command, keys, false)
            })
            .collect();
        for (name, specs) in overrides {
            let Some(command) = Command::from_name(name) else {
                warnings.push(format!("unknown keybinding action `{name}`"));
                continue;
            };
            let mut keys = Vec::new();
            for spec in specs {
                match KeySpec::parse(spec) {
                    Ok(key) if !keys.contains(&key) => keys.push(key),
                    Ok(_) => {}
                    Err(error) => warnings.push(format!("keybinding `{name}`: {error}")),
                }
            }
            if keys.is_empty() && !specs.is_empty() {
                // Every spec was invalid: keep the defaults rather than unbinding.
                continue;
            }
            if let Some(entry) = bindings.iter_mut().find(|(c, _, _)| *c == command) {
                entry.1 = keys;
                entry.2 = true;
            }
        }
        (Self { bindings }, warnings)
    }

    /// The action bound to this key. User overrides win over conflicting defaults.
    pub fn lookup(&self, key: &KeyEvent) -> Option<Command> {
        self.lookup_spec(KeySpec::from_event(key))
    }

    pub fn lookup_spec(&self, spec: KeySpec) -> Option<Command> {
        let find = |custom: bool| {
            self.bindings
                .iter()
                .filter(|(_, _, overridden)| *overridden == custom)
                .find(|(_, keys, _)| keys.contains(&spec))
                .map(|(command, _, _)| *command)
        };
        find(true).or_else(|| find(false))
    }

    #[cfg(test)]
    pub fn keys(&self, command: Command) -> &[KeySpec] {
        self.bindings
            .iter()
            .find(|(c, _, _)| *c == command)
            .map_or(&[], |(_, keys, _)| keys.as_slice())
    }

    /// Human-readable table of the effective bindings.
    pub fn describe(&self) -> String {
        let mut out = String::new();
        for (command, keys, overridden) in &self.bindings {
            let keys = if keys.is_empty() {
                "(unbound)".to_owned()
            } else {
                keys.iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let mark = if *overridden { "  (custom)" } else { "" };
            out.push_str(&format!("  {:<20} {keys}{mark}\n", command.name()));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect()))
            .collect()
    }

    fn ev(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn parses_specs() {
        let spec = KeySpec::parse("Ctrl+Shift+Enter").unwrap();
        assert_eq!(spec.code, KeyCode::Enter);
        assert_eq!(spec.modifiers, KeyModifiers::CONTROL | KeyModifiers::SHIFT);
        assert_eq!(KeySpec::parse("f12").unwrap().code, KeyCode::F(12));
        assert_eq!(KeySpec::parse("space").unwrap().code, KeyCode::Char(' '));
        assert_eq!(KeySpec::parse("ctrl++").unwrap().code, KeyCode::Char('+'));
        assert_eq!(KeySpec::parse("PageDown").unwrap().code, KeyCode::PageDown);
        assert_eq!(
            KeySpec::parse("meta+x").unwrap().modifiers,
            KeyModifiers::META
        );
        assert_eq!(KeySpec::parse("ctrl+R"), KeySpec::parse("ctrl+r"));
        assert!(KeySpec::parse("hyper+x").is_err());
        assert!(KeySpec::parse("ctrl+").is_err());
        assert!(KeySpec::parse("f13").is_err());
        assert!(KeySpec::parse("enterr").is_err());
        assert!(KeySpec::parse("").is_err());
    }

    #[test]
    fn display_round_trips() {
        for spec in [
            "ctrl+j",
            "shift+enter",
            "alt+left",
            "f5",
            "space",
            "shift+tab",
        ] {
            assert_eq!(KeySpec::parse(spec).unwrap().to_string(), spec);
        }
    }

    #[test]
    fn events_normalize() {
        let keymap = Keymap::default();
        assert_eq!(
            keymap.lookup(&ev(KeyCode::BackTab, KeyModifiers::SHIFT)),
            Some(Command::CycleMode)
        );
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Enter, KeyModifiers::NONE)),
            Some(Command::Submit)
        );
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            Some(Command::HistorySearch)
        );
        // Plain characters are not bound by default.
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Char('a'), KeyModifiers::NONE)),
            None
        );
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Char('A'), KeyModifiers::SHIFT)),
            None
        );
    }

    #[test]
    fn overrides_replace_defaults_and_win_conflicts() {
        let (keymap, warnings) = Keymap::new(&map(&[
            ("submit", &["enter"]),
            ("newline", &["shift+enter", "ctrl+j"]),
            ("history-search", &["ctrl+s", "bogus+x"]),
            ("noSuchAction", &["ctrl+x"]),
        ]));
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Char('j'), KeyModifiers::CONTROL)),
            Some(Command::Newline)
        );
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Char('s'), KeyModifiers::CONTROL)),
            Some(Command::HistorySearch)
        );
        // The default ctrl+r binding was replaced.
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            None
        );
        // alt+enter was a newline default and is gone.
        assert_eq!(keymap.lookup(&ev(KeyCode::Enter, KeyModifiers::ALT)), None);
        assert!(keymap.describe().contains("historySearch"));
        assert!(keymap.describe().contains("(custom)"));
    }

    #[test]
    fn empty_list_unbinds_and_all_invalid_keeps_defaults() {
        let (keymap, warnings) = Keymap::new(&map(&[("clearScreen", &[]), ("exit", &["nope+q"])]));
        assert_eq!(warnings.len(), 1);
        assert!(keymap.keys(Command::ClearScreen).is_empty());
        assert_eq!(
            keymap.lookup(&ev(KeyCode::Char('d'), KeyModifiers::CONTROL)),
            Some(Command::Exit)
        );
    }

    #[test]
    fn names_and_aliases() {
        assert_eq!(
            Command::from_name("historySearch"),
            Some(Command::HistorySearch)
        );
        assert_eq!(
            Command::from_name("HISTORY_SEARCH"),
            Some(Command::HistorySearch)
        );
        assert_eq!(Command::from_name("escape"), Some(Command::Cancel));
        assert_eq!(Command::from_name("nope"), None);
        for (command, name, _) in DEFAULTS {
            assert_eq!(Command::from_name(name), Some(*command));
            assert_eq!(command.name(), *name);
        }
    }
}
