//! User preferences for the interactive terminal, stored in `<miniq dir>/cli.json`.
//!
//! ```json
//! {
//!   "editorMode": "vim",
//!   "keybindings": {"submit": "enter", "newline": ["shift+enter", "ctrl+j"]},
//!   "statusLine": {"command": "~/bin/status.sh", "timeoutMs": 500, "replace": false}
//! }
//! ```
//!
//! Every field is optional and unknown fields are ignored. A malformed file is
//! reported once and the defaults are used.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};

pub const FILE_NAME: &str = "cli.json";
pub const DEFAULT_STATUS_TIMEOUT_MS: u64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EditorMode {
    #[default]
    Emacs,
    Vim,
}

impl EditorMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Emacs => "emacs",
            Self::Vim => "vim",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusLineConfig {
    pub command: String,
    pub timeout_ms: u64,
    /// Replace the built-in status line instead of appending to it.
    pub replace: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prefs {
    pub editor_mode: EditorMode,
    pub keybindings: BTreeMap<String, Vec<String>>,
    pub status_line: Option<StatusLineConfig>,
}

pub fn path(directory: &Path) -> PathBuf {
    directory.join(FILE_NAME)
}

impl Prefs {
    /// Load `cli.json` from `directory`. Missing file means defaults; problems are
    /// returned as warnings (the affected field or file falls back to defaults).
    pub fn load(directory: &Path) -> (Self, Vec<String>) {
        let file = path(directory);
        match fs::read_to_string(&file) {
            Ok(text) => Self::parse(&text, &file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (Self::default(), Vec::new())
            }
            Err(error) => (
                Self::default(),
                vec![format!("cannot read {}: {error}", file.display())],
            ),
        }
    }

    /// Load and print any warnings to stderr (once, before the terminal enters raw mode).
    pub fn load_reporting(directory: &Path) -> Self {
        let (prefs, warnings) = Self::load(directory);
        for warning in warnings {
            eprintln!("miniq: warning: {warning}");
        }
        prefs
    }

    pub fn parse(text: &str, file: &Path) -> (Self, Vec<String>) {
        let mut warnings = Vec::new();
        let mut prefs = Self::default();
        if text.trim().is_empty() {
            return (prefs, warnings);
        }
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(error) => {
                warnings.push(format!(
                    "{} is not valid JSON ({error}); using defaults",
                    file.display()
                ));
                return (prefs, warnings);
            }
        };
        let Some(object) = value.as_object() else {
            warnings.push(format!(
                "{} must contain a JSON object; using defaults",
                file.display()
            ));
            return (prefs, warnings);
        };
        let mut warn = |text: String| warnings.push(format!("{}: {text}", file.display()));

        match object.get("editorMode") {
            None | Some(Value::Null) => {}
            Some(Value::String(mode)) => match mode.trim().to_ascii_lowercase().as_str() {
                "emacs" | "default" => prefs.editor_mode = EditorMode::Emacs,
                "vim" | "vi" => prefs.editor_mode = EditorMode::Vim,
                other => warn(format!("unknown editorMode `{other}` (use emacs or vim)")),
            },
            Some(_) => warn("editorMode must be a string".into()),
        }

        match object.get("keybindings") {
            None | Some(Value::Null) => {}
            Some(Value::Object(map)) => {
                for (action, specs) in map {
                    match specs {
                        Value::String(spec) => {
                            prefs.keybindings.insert(action.clone(), vec![spec.clone()]);
                        }
                        Value::Array(items) => {
                            let mut list = Vec::new();
                            for item in items {
                                match item.as_str() {
                                    Some(spec) => list.push(spec.to_owned()),
                                    None => warn(format!(
                                        "keybindings.{action}: entries must be strings"
                                    )),
                                }
                            }
                            prefs.keybindings.insert(action.clone(), list);
                        }
                        _ => warn(format!(
                            "keybindings.{action} must be a key spec or a list of key specs"
                        )),
                    }
                }
            }
            Some(_) => warn("keybindings must be an object".into()),
        }

        match object.get("statusLine") {
            None | Some(Value::Null) => {}
            Some(Value::Object(config)) => {
                let command = match config.get("command") {
                    Some(Value::String(command)) => command.trim().to_owned(),
                    None | Some(Value::Null) => String::new(),
                    Some(_) => {
                        warn("statusLine.command must be a string".into());
                        String::new()
                    }
                };
                let timeout_ms = match config.get("timeoutMs") {
                    None | Some(Value::Null) => DEFAULT_STATUS_TIMEOUT_MS,
                    Some(value) => match value.as_u64() {
                        Some(ms) if ms > 0 => ms.min(60_000),
                        _ => {
                            warn("statusLine.timeoutMs must be a positive integer".into());
                            DEFAULT_STATUS_TIMEOUT_MS
                        }
                    },
                };
                let replace = match config.get("replace") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(replace)) => *replace,
                    Some(_) => {
                        warn("statusLine.replace must be true or false".into());
                        false
                    }
                };
                if !command.is_empty() {
                    prefs.status_line = Some(StatusLineConfig {
                        command,
                        timeout_ms,
                        replace,
                    });
                }
            }
            Some(_) => warn("statusLine must be an object".into()),
        }
        (prefs, warnings)
    }
}

/// Persist `editorMode`, keeping every other field of an existing `cli.json`.
pub fn save_editor_mode(directory: &Path, mode: EditorMode) -> Result<PathBuf> {
    let file = path(directory);
    let mut object = match fs::read_to_string(&file) {
        Ok(text) if text.trim().is_empty() => Map::new(),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(object)) => object,
            _ => bail!(
                "{} is malformed; fix it before saving preferences",
                file.display()
            ),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(error) => return Err(error).with_context(|| format!("reading {}", file.display())),
    };
    object.insert("editorMode".into(), Value::String(mode.as_str().into()));
    fs::create_dir_all(directory).with_context(|| format!("creating {}", directory.display()))?;
    let temp = file.with_extension("json.tmp");
    {
        let mut out =
            fs::File::create(&temp).with_context(|| format!("writing {}", temp.display()))?;
        let text = serde_json::to_string_pretty(&Value::Object(object))?;
        out.write_all(text.as_bytes())?;
        out.write_all(b"\n")?;
    }
    fs::rename(&temp, &file).with_context(|| format!("writing {}", file.display()))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> (Prefs, Vec<String>) {
        Prefs::parse(text, Path::new("cli.json"))
    }

    #[test]
    fn defaults_when_missing_or_empty() {
        let dir = tempfile::tempdir().unwrap();
        let (prefs, warnings) = Prefs::load(dir.path());
        assert_eq!(prefs, Prefs::default());
        assert!(warnings.is_empty());
        assert_eq!(parse("  \n").0, Prefs::default());
    }

    #[test]
    fn parses_all_fields_and_ignores_unknown() {
        let (prefs, warnings) = parse(
            r#"{
                "editorMode": "Vim",
                "keybindings": {"submit": "enter", "newline": ["shift+enter", "ctrl+j"]},
                "statusLine": {"command": "echo hi", "timeoutMs": 250, "replace": true},
                "somethingElse": 42
            }"#,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(prefs.editor_mode, EditorMode::Vim);
        assert_eq!(prefs.keybindings["submit"], vec!["enter".to_string()]);
        assert_eq!(prefs.keybindings["newline"].len(), 2);
        assert_eq!(
            prefs.status_line,
            Some(StatusLineConfig {
                command: "echo hi".into(),
                timeout_ms: 250,
                replace: true
            })
        );
    }

    #[test]
    fn status_line_defaults() {
        let (prefs, _) = parse(r#"{"statusLine": {"command": "date"}}"#);
        let config = prefs.status_line.unwrap();
        assert_eq!(config.timeout_ms, DEFAULT_STATUS_TIMEOUT_MS);
        assert!(!config.replace);
        assert_eq!(parse(r#"{"statusLine": {}}"#).0.status_line, None);
    }

    #[test]
    fn malformed_file_falls_back_with_one_warning() {
        let (prefs, warnings) = parse("{ not json");
        assert_eq!(prefs, Prefs::default());
        assert_eq!(warnings.len(), 1);
        let (prefs, warnings) = parse("[1, 2]");
        assert_eq!(prefs, Prefs::default());
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn bad_fields_warn_and_default() {
        let (prefs, warnings) = parse(
            r#"{"editorMode": "nano", "keybindings": {"submit": 3}, "statusLine": {"command": "x", "timeoutMs": -1}}"#,
        );
        assert_eq!(prefs.editor_mode, EditorMode::Emacs);
        assert!(prefs.keybindings.is_empty());
        assert_eq!(prefs.status_line.unwrap().timeout_ms, 500);
        assert_eq!(warnings.len(), 3, "{warnings:?}");
    }

    #[test]
    fn save_editor_mode_preserves_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let written = save_editor_mode(dir.path(), EditorMode::Vim).unwrap();
        assert_eq!(written, dir.path().join("cli.json"));
        assert_eq!(Prefs::load(dir.path()).0.editor_mode, EditorMode::Vim);

        fs::write(
            &written,
            r#"{"editorMode":"vim","keybindings":{"submit":"enter"},"custom":true}"#,
        )
        .unwrap();
        save_editor_mode(dir.path(), EditorMode::Emacs).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&written).unwrap()).unwrap();
        assert_eq!(value["editorMode"], "emacs");
        assert_eq!(value["keybindings"]["submit"], "enter");
        assert_eq!(value["custom"], true);

        fs::write(&written, "{broken").unwrap();
        assert!(save_editor_mode(dir.path(), EditorMode::Vim).is_err());
        assert_eq!(fs::read_to_string(&written).unwrap(), "{broken");
    }
}
