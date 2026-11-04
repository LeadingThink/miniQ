use super::*;
use std::fs;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

fn editor() -> Editor {
    Editor::new(
        vec![
            ("/models".into(), "switch model".into()),
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
fn ctrl_h_is_an_alternate_backspace() {
    let mut e = editor();
    typed(&mut e, "hello");
    e.key(ctrl('h'));
    assert_eq!(e.buffer(), "hell");
    e.key(key(KeyCode::Home));
    e.key(key(KeyCode::Delete));
    assert_eq!(e.buffer(), "ell");
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
    typed(&mut e, "/models");
    assert_eq!(e.key(key(KeyCode::Enter)), Action::Submit("/models".into()));
}

#[test]
fn tab_without_completion_is_reported() {
    let mut e = editor();
    typed(&mut e, "plain");
    assert_eq!(e.key(key(KeyCode::Tab)), Action::Tab);
}

#[test]
fn model_completion_offers_one_command_from_the_real_catalog() {
    let mut e = Editor::new(crate::repl::commands::list(), PathBuf::from("."));
    typed(&mut e, "/model");
    let menu = e.menu.as_ref().unwrap();
    assert_eq!(menu.items.len(), 1);
    assert_eq!(menu.items[0].0, "/models");
    e.key(key(KeyCode::Tab));
    assert_eq!(e.buffer(), "/models ");
    assert_eq!(
        e.key(key(KeyCode::Enter)),
        Action::Submit("/models ".into())
    );
}

#[test]
fn fuzzy_file_matching() {
    let files = vec![
        "src/main.rs".to_string(),
        "src/repl/editor.rs".to_string(),
        "README.md".to_string(),
    ];
    assert_eq!(fuzzy(&files, "edtr"), vec!["src/repl/editor.rs"]);
    assert_eq!(fuzzy(&files, "main")[0], "src/main.rs");
    assert!(fuzzy(&files, "zzz").is_empty());
}

#[test]
fn at_completion_respects_gitignore() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".git")).unwrap();
    fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
    fs::create_dir(dir.path().join("target")).unwrap();
    fs::write(dir.path().join("target/out.rs"), "").unwrap();
    fs::write(dir.path().join("lib.rs"), "").unwrap();
    let files = list_files(dir.path());
    assert!(files.contains(&"lib.rs".to_string()));
    assert!(!files.iter().any(|f| f.starts_with("target")));

    let mut e = Editor::new(Vec::new(), dir.path().to_path_buf());
    typed(&mut e, "see @li");
    e.key(key(KeyCode::Tab));
    assert_eq!(e.buffer(), "see @lib.rs ");
}

#[test]
fn at_opens_all_file_candidates_without_requiring_a_query_or_tab() {
    let dir = tempfile::tempdir().unwrap();
    for index in 0..20 {
        fs::write(dir.path().join(format!("file-{index:02}.rs")), "").unwrap();
    }
    let mut e = Editor::new(Vec::new(), dir.path().to_path_buf());
    typed(&mut e, "@");
    assert_eq!(e.menu.as_ref().unwrap().items.len(), 20);
    for _ in 0..19 {
        e.key(key(KeyCode::Down));
    }
    e.key(key(KeyCode::Tab));
    assert_eq!(e.buffer(), "@file-19.rs ");
}

#[test]
fn vim_normal_mode_editing() {
    let mut e = editor();
    e.set_vim(true);
    assert_eq!(e.mode_indicator(), Some("-- INSERT --"));
    typed(&mut e, "hello world");
    e.key(key(KeyCode::Esc));
    assert_eq!(e.mode_indicator(), Some("-- NORMAL --"));
    typed(&mut e, "0dw");
    assert_eq!(e.buffer(), "world");
    typed(&mut e, "Aa");
    assert_eq!(e.mode_indicator(), Some("-- INSERT --"));
    assert_eq!(e.buffer(), "worlda");
    e.key(key(KeyCode::Esc));
    typed(&mut e, "x");
    assert_eq!(e.buffer(), "world");
    assert_eq!(e.key(key(KeyCode::Enter)), Action::Submit("world".into()));
    assert_eq!(e.mode_indicator(), Some("-- INSERT --"));
}

#[test]
fn user_keybinding_overrides_defaults() {
    let mut bindings = std::collections::BTreeMap::new();
    bindings.insert("newline".to_string(), vec!["ctrl+o".to_string()]);
    let (keymap, warnings) = Keymap::new(&bindings);
    assert!(warnings.is_empty());
    let mut e = editor().with_keymap(keymap);
    typed(&mut e, "a");
    e.key(ctrl('o'));
    typed(&mut e, "b");
    assert_eq!(e.key(key(KeyCode::Enter)), Action::Submit("a\nb".into()));
}
