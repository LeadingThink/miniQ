use super::*;
use ratatui::{backend::TestBackend, Terminal};
use serde_json::json;

#[path = "interaction_screen_tests.rs"]
mod interactions;

fn editor() -> Editor {
    Editor::new(crate::repl::commands::list(), std::path::PathBuf::from("."))
}
fn status() -> Status {
    Status {
        model: "Claude Sonnet".into(),
        effort: "high".into(),
        cwd: "~/projects/miniq".into(),
        color: true,
        animations: true,
        theme: "dark".into(),
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
    let buffer = terminal.backend().buffer();
    let mut text = String::new();
    for y in 0..buffer.area.height {
        let mut x = 0;
        while x < buffer.area.width {
            let symbol = buffer[(x, y)].symbol();
            text.push_str(symbol);
            x += unicode_width::UnicodeWidthStr::width(symbol).max(1) as u16;
        }
    }
    text
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

#[test]
fn waiting_for_first_token_animates_after_the_message_and_below_the_prompt() {
    let mut screen = Screen::default();
    screen.transcript.restore(&json!({"messages":[
        {"id":"u","role":"user","content":"你在干什么","createdAt":"1"}]}));
    let mut state = status();
    state.running = true;
    state.phase = "Thinking".into();
    state.custom = Some(("custom idle status".into(), true));
    let first = draw(&mut screen, &editor(), &state, 100, 30);
    let row = screen.transcript_area.y + screen.cached.len() as u16;
    let x = screen.transcript_area.x + 2;
    assert_eq!(first.backend().buffer()[(x, row)].symbol(), "⠋");
    assert_eq!(first.backend().buffer()[(x, row)].fg, text::ACCENT);
    assert!(row < screen.composer_area.y);
    assert!(contents(&first).contains("Thinking  0s"));
    assert!(contents(&first).contains("■⬝⬝⬝⬝⬝⬝⬝  0s  esc interrupt"));
    assert!(!contents(&first).contains("custom idle status"));
    preview("waiting-first-token", &first);

    let cached = screen.cached.clone();
    state.elapsed = Duration::from_millis(80);
    let next = draw(&mut screen, &editor(), &state, 100, 30);
    assert_eq!(next.backend().buffer()[(x, row)].symbol(), "⠙");
    assert!(contents(&next).contains("■■■⬝⬝⬝⬝⬝"));
    assert_eq!(screen.cached, cached);
    assert_eq!(screen.transcript.entries.len(), 1);
    preview("waiting-next-frame", &next);

    state.running = false;
    let complete = draw(&mut screen, &editor(), &state, 100, 30);
    assert!(!contents(&complete).contains("Thinking"));
    assert!(!contents(&complete).contains("esc interrupt"));
    assert!(contents(&complete).contains("custom idle status"));
    assert_eq!(screen.total, cached.len());
}

#[test]
fn busy_indicator_keeps_history_scroll_and_survives_narrow_no_color_rendering() {
    let mut screen = Screen::default();
    screen
        .transcript
        .notice(&format!("FIRST_MESSAGE\n{}", "history\n".repeat(60)));
    let mut state = status();
    state.running = true;
    state.phase = "Running shell".into();
    state.elapsed = Duration::from_millis(2480);
    screen.scroll = Some(0);
    let first = draw(&mut screen, &editor(), &state, 80, 24);
    state.elapsed += Duration::from_millis(80);
    let next = draw(&mut screen, &editor(), &state, 80, 24);
    assert!(contents(&first).contains("FIRST_MESSAGE"));
    assert!(contents(&next).contains("FIRST_MESSAGE"));
    assert_eq!(screen.top, 0);
    assert!(contents(&next).contains("esc interrupt"));

    screen.scroll = None;
    state.color = false;
    for (width, height) in [(12, 7), (40, 12), (80, 24)] {
        let terminal = draw(&mut screen, &editor(), &state, width, height);
        for cell in &terminal.backend().buffer().content {
            assert_eq!(cell.fg, ratatui::style::Color::Reset);
            assert_eq!(cell.bg, ratatui::style::Color::Reset);
        }
        if height > 7 {
            assert!(contents(&terminal).contains("Running shell  2s"));
        }
    }
}

#[test]
fn pending_input_replaces_busy_animation_until_the_user_responds() {
    let mut screen = Screen::default();
    screen.transcript.notice("Previous output");
    let mut state = status();
    state.running = true;
    state.phase = "Thinking".into();
    state.card = Some((
        "Allow this command?".into(),
        vec!["Allow once".into(), "Reject".into()],
    ));
    let pending = draw(&mut screen, &editor(), &state, 100, 30);
    assert!(contents(&pending).contains("Waiting for your response"));
    assert!(!contents(&pending).contains("Thinking"));
    assert!(!contents(&pending).contains("esc interrupt"));
    state.elapsed = Duration::from_millis(240);
    let next = draw(&mut screen, &editor(), &state, 100, 30);
    assert_eq!(contents(&pending), contents(&next));
    state.card = None;
    let resumed = draw(&mut screen, &editor(), &state, 100, 30);
    assert!(contents(&resumed).contains("Thinking"));
    assert!(contents(&resumed).contains("esc interrupt"));
}

/// Export the actual production frame for visual review when explicitly requested.
fn preview(name: &str, terminal: &Terminal<TestBackend>) {
    let Some(directory) = std::env::var_os("MINIQ_TUI_PREVIEW_DIR") else {
        return;
    };
    let buffer = terminal.backend().buffer();
    let color = |value, default: &str| match value {
        ratatui::style::Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        _ => default.to_owned(),
    };
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\"><rect width=\"100%\" height=\"100%\" fill=\"#141414\"/><g font-family=\"Consolas,monospace\" font-size=\"15\">", buffer.area.width as usize * 9, buffer.area.height as usize * 20);
    for y in 0..buffer.area.height {
        let mut next_x = 0;
        for x in 0..buffer.area.width {
            if x < next_x {
                continue;
            }
            let cell = &buffer[(x, y)];
            let width = unicode_width::UnicodeWidthStr::width(cell.symbol()).max(1);
            next_x = x + width as u16;
            svg.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"20\" fill=\"{}\"/>",
                x as usize * 9,
                y as usize * 20,
                width * 9,
                color(cell.bg, "#141414")
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
                color(cell.fg, "#eeeeee"),
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
