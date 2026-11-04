use super::*;
use ratatui::{backend::TestBackend, Terminal};
use serde_json::json;

fn editor() -> Editor {
    Editor::new(crate::repl::commands::list(), std::path::PathBuf::from("."))
}
fn status() -> Status {
    Status {
        model: "Claude Sonnet".into(),
        effort: "high".into(),
        cwd: "~/projects/miniq".into(),
        color: true,
        mode: "alwaysAsk".into(),
        ..Default::default()
    }
}
fn draw(
    screen: &mut Screen,
    editor: &Editor,
    status: &Status,
    width: u16,
    height: u16,
) -> Terminal<TestBackend> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| screen.draw(frame, editor, status))
        .unwrap();
    terminal
}
fn contents(terminal: &Terminal<TestBackend>) -> String {
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect()
}

#[test]
fn home_centers_the_prompt_and_keeps_model_and_command_hints_visible() {
    let mut screen = Screen::default();
    let terminal = draw(&mut screen, &editor(), &status(), 100, 32);
    let text = contents(&terminal);
    assert!(text.contains("Ask anything…") && text.contains("Claude Sonnet"));
    assert!(text.contains("ctrl+p commands"));
    assert_eq!(screen.composer_area.width, 75);
    assert!(screen.composer_area.y > 6 && screen.composer_area.bottom() < 30);
    preview("home", &terminal);
}

#[test]
fn conversation_stays_above_the_fixed_composer_and_can_scroll_to_oldest_output() {
    let mut screen = Screen::default();
    screen.transcript.restore(&json!({"messages":[
        {"id":"u","role":"user","content":"Review this project","createdAt":"1"},
        {"id":"a","role":"assistant","content":format!("# Findings\n{}\nLAST_MARKER", "A useful explanation.\n".repeat(90)),"createdAt":"2"}]}));
    let mut state = status();
    state.title = "Review the terminal interface".into();
    let terminal = draw(&mut screen, &editor(), &state, 130, 34);
    assert!(contents(&terminal).contains("LAST_MARKER"));
    assert!(contents(&terminal).contains("Context"));
    assert_eq!(screen.composer_area.bottom(), 33);
    screen.scroll = Some(0);
    let terminal = draw(&mut screen, &editor(), &state, 130, 34);
    assert!(contents(&terminal).contains("Review this project"));
    assert!(!contents(&terminal).contains("LAST_MARKER"));
    preview("session", &terminal);
}

#[test]
fn long_multiline_cjk_input_keeps_caret_visible_at_all_supported_sizes() {
    let mut screen = Screen::default();
    let mut editor = editor();
    editor.insert(&format!("{}\nEND", "中文输入👩‍💻\n".repeat(60)));
    for (width, height) in [(1, 1), (12, 7), (40, 12), (80, 24), (160, 48)] {
        let mut terminal = draw(&mut screen, &editor, &status(), width, height);
        let cursor = terminal.get_cursor_position().unwrap();
        assert!(cursor.x < width && cursor.y < height);
        if height > 10 {
            assert!(contents(&terminal).contains("END"));
        }
    }
}

#[test]
fn completion_pages_follow_selection_past_the_eighth_item() {
    let mut screen = Screen::default();
    let mut editor = editor();
    editor.insert("/");
    let menu = editor.menu.as_mut().unwrap();
    menu.selected = menu.items.len() - 1;
    let last = menu.items.last().unwrap().0.clone();
    let terminal = draw(&mut screen, &editor, &status(), 100, 32);
    assert!(contents(&terminal).contains(&last));
}

#[test]
fn picker_keyboard_search_and_paging_reach_every_model() {
    use crate::repl::picker::{Item, Outcome, Picker, Purpose};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    let mut picker = Picker::new(
        Purpose::Models,
        "Select model",
        (0..120)
            .map(|i| Item::new(&format!("model-{i}"), &format!("Model {i}"), "Text model"))
            .collect(),
        None,
    );
    for _ in 0..119 {
        picker.key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    }
    let mut screen = Screen::default();
    screen.picker = Some(picker);
    let terminal = draw(&mut screen, &editor(), &status(), 100, 32);
    assert!(contents(&terminal).contains("Model 119"));
    preview("models", &terminal);
    let picker = screen.picker.as_mut().unwrap();
    let Outcome::Choose(value) = picker.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("no selection")
    };
    assert_eq!(value, "model-119");
    for c in "model-5".chars() {
        picker.key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
    }
    assert_eq!(picker.selected, 0);
    assert_eq!(picker.matches().len(), 11);
}

#[test]
fn no_color_resets_every_cell_foreground_and_background() {
    let mut state = status();
    state.color = false;
    let terminal = draw(&mut Screen::default(), &editor(), &state, 80, 24);
    for cell in &terminal.backend().buffer().content {
        assert_eq!(cell.fg, ratatui::style::Color::Reset);
        assert_eq!(cell.bg, ratatui::style::Color::Reset);
    }
}

#[test]
fn approval_and_question_panels_survive_resize_and_scroll_complete_details() {
    let mut screen = Screen::default();
    let mut state = status();
    let mut input = editor();
    input.insert(&"draft\n".repeat(30));
    for choices in [vec![], vec!["Allow once".into(), "Reject".into()]] {
        state.card = Some((
            format!("{}\nLAST_DETAIL", "Long request\n".repeat(60)),
            choices,
        ));
        for (width, height) in [(1, 1), (12, 7), (40, 12), (40, 13), (80, 24)] {
            draw(&mut screen, &input, &state, width, height);
            if height >= 13 {
                assert!(screen.card_area.height >= 3);
                assert!(screen.card_area.bottom() <= screen.composer_area.y);
                screen.card_offset = usize::MAX;
                let terminal = draw(&mut screen, &input, &state, width, height);
                assert!(contents(&terminal).contains("LAST_DETAIL"));
            }
        }
    }
}

#[test]
fn long_picker_items_keep_selection_visible_and_details_scrollable() {
    use crate::repl::picker::{Item, Picker, Purpose};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    let mut screen = Screen::default();
    screen.picker = Some(Picker::new(
        Purpose::Sessions,
        "Sessions",
        vec![
            Item::new("old", &"Previous long title ".repeat(200), ""),
            Item::new(
                "selected",
                "SELECTED_SESSION",
                &format!("{}\nLAST_DETAIL", "details\n".repeat(50)),
            ),
        ],
        Some("selected".into()),
    ));
    for (width, height) in [(12, 7), (40, 12), (100, 32)] {
        let terminal = draw(&mut screen, &editor(), &status(), width, height);
        if height >= 12 {
            assert!(contents(&terminal).contains("SELECTED_SESSION"));
        }
    }
    for _ in 0..60 {
        screen
            .picker
            .as_mut()
            .unwrap()
            .key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT));
    }
    let terminal = draw(&mut screen, &editor(), &status(), 100, 32);
    assert!(contents(&terminal).contains("LAST_DETAIL"));
}

#[test]
fn sidebar_can_scroll_to_the_last_plan_item_without_moving_the_conversation() {
    let mut screen = Screen::default();
    screen.transcript.notice("Conversation");
    screen.plan = json!((0..60)
        .map(|i| json!({"content":format!("Task {i}"),"status":"pending"}))
        .collect::<Vec<_>>());
    let terminal = draw(&mut screen, &editor(), &status(), 130, 34);
    assert!(!contents(&terminal).contains("Task 59"));
    screen.sidebar_offset = usize::MAX;
    let terminal = draw(&mut screen, &editor(), &status(), 130, 34);
    assert!(contents(&terminal).contains("Task 59"));
    assert!(contents(&terminal).contains("Conversation"));
    assert!(screen.scroll.is_none());
}

#[test]
fn new_streaming_output_preserves_a_scrolled_viewport() {
    let mut screen = Screen::default();
    screen
        .transcript
        .notice(&format!("FIRST_MESSAGE\n{}", "history\n".repeat(60)));
    screen.scroll = Some(0);
    let first = draw(&mut screen, &editor(), &status(), 80, 24);
    assert!(contents(&first).contains("FIRST_MESSAGE"));
    screen
        .transcript
        .event(&json!({"type":"assistant_delta","delta":"new output\n".repeat(100)}));
    let after = draw(&mut screen, &editor(), &status(), 80, 24);
    assert!(contents(&after).contains("FIRST_MESSAGE"));
    assert_eq!(screen.top, 0);
    screen.scroll = None;
    let latest = draw(&mut screen, &editor(), &status(), 80, 24);
    assert!(contents(&latest).contains("new output"));
}

/// Export the actual production frame for visual review when explicitly requested.
fn preview(name: &str, terminal: &Terminal<TestBackend>) {
    let Some(directory) = std::env::var_os("MINIQ_TUI_PREVIEW_DIR") else {
        return;
    };
    let buffer = terminal.backend().buffer();
    let color = |value| match value {
        ratatui::style::Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        _ => "#eeeeee".into(),
    };
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\"><rect width=\"100%\" height=\"100%\" fill=\"#141414\"/><g font-family=\"Consolas,monospace\" font-size=\"15\">", buffer.area.width as usize * 9, buffer.area.height as usize * 20);
    for y in 0..buffer.area.height {
        for x in 0..buffer.area.width {
            let cell = &buffer[(x, y)];
            svg.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"9\" height=\"20\" fill=\"{}\"/>",
                x as usize * 9,
                y as usize * 20,
                color(cell.bg)
            ));
        }
    }
    for y in 0..buffer.area.height {
        for x in 0..buffer.area.width {
            let cell = &buffer[(x, y)];
            svg.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" fill=\"{}\">{}</text>",
                x as usize * 9,
                y as usize * 20 + 15,
                color(cell.fg),
                escape(cell.symbol())
            ));
        }
    }
    svg.push_str("</g></svg>");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        std::path::Path::new(&directory).join(format!("{name}.svg")),
        svg,
    )
    .unwrap();
}
