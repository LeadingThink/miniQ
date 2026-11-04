use super::*;
use crate::repl::{
    image_preview::ImagePreview,
    picker::{Item, Picker, Purpose},
    reader::Reader,
};

#[test]
fn model_loading_error_retry_and_queue_panels_fit_the_terminal() {
    let mut screen = Screen::default();
    let mut picker = Picker::new(Purpose::Models, "Choose model", vec![], None);
    picker.loading = true;
    screen.picker = Some(picker);
    let loading = draw(&mut screen, &editor(), &status(), 100, 30);
    assert!(contents(&loading).contains("Loading"));
    preview("models-loading", &loading);
    screen.picker.as_mut().unwrap().loading = false;
    screen.picker.as_mut().unwrap().error = Some("Connection lost".into());
    let failed = draw(&mut screen, &editor(), &status(), 100, 30);
    assert!(contents(&failed).contains("ctrl+r"));
    assert!(contents(&failed).contains("Connection lost"));
    preview("models-error", &failed);
    screen.picker = Some(Picker::new(
        Purpose::QueueActions,
        "Queued message",
        vec![
            Item::new(
                "edit",
                "Edit message",
                "Update text while preserving its attachments",
            ),
            Item::new("up", "Move earlier", ""),
            Item::new("steer", "Steer current turn", ""),
            Item::new("remove", "Remove from queue", "Requires confirmation"),
        ],
        None,
    ));
    let queued = draw(&mut screen, &editor(), &status(), 100, 30);
    assert!(contents(&queued).contains("Steer current turn"));
    preview("queue-actions", &queued);
    for (w, h) in [(12, 7), (40, 12), (80, 24)] {
        draw(&mut screen, &editor(), &status(), w, h);
    }
}

#[test]
fn multiselect_buttons_have_click_targets_and_light_theme_is_applied() {
    let mut screen = Screen::default();
    let mut state = status();
    state.theme = "light".into();
    state.card = Some((
        "选择需要实现的功能".into(),
        vec![
            "[x] 消息搜索".into(),
            "[ ] 图片预览".into(),
            "Submit selection".into(),
        ],
    ));
    let terminal = draw(&mut screen, &editor(), &state, 100, 30);
    assert_eq!(screen.card_hits.len(), 3);
    assert!(contents(&terminal).contains("[x] 消息搜索"));
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].bg,
        ratatui::style::Color::Rgb(250, 250, 250)
    );
    preview("light-multiselect", &terminal);
}

#[test]
fn disabling_animation_keeps_the_same_glyphs_but_updates_elapsed_time() {
    let mut screen = Screen::default();
    screen.transcript.notice("Waiting for reply");
    let mut state = status();
    state.animations = false;
    state.running = true;
    state.phase = "Thinking".into();
    let first = draw(&mut screen, &editor(), &state, 100, 30);
    state.elapsed = Duration::from_millis(240);
    let second = draw(&mut screen, &editor(), &state, 100, 30);
    assert_eq!(contents(&first), contents(&second));
    state.elapsed = Duration::from_secs(2);
    let later = draw(&mut screen, &editor(), &state, 100, 30);
    assert!(contents(&later).contains("Thinking  2s"));
}

#[test]
fn image_preview_keeps_truecolor_pixels_in_each_theme() {
    let mut screen = Screen::default();
    let pixels = image::RgbImage::from_fn(80, 40, |x, y| {
        image::Rgb([(x * 3) as u8, (y * 6) as u8, 128])
    });
    let value = json!({"width":80,"height":40,"pixels":pixels.into_raw()});
    let mut reader = Reader::new("image.png", "80 × 40 pixels · o opens original");
    reader.image = ImagePreview::from_value(&value);
    screen.reader = Some(reader);
    for theme in ["dark", "light", "system"] {
        let mut state = status();
        state.theme = theme.into();
        let frame = draw(&mut screen, &editor(), &state, 100, 30);
        let cell = frame
            .backend()
            .buffer()
            .content
            .iter()
            .find(|cell| cell.symbol() == "▀")
            .unwrap();
        assert!(matches!(cell.fg, ratatui::style::Color::Rgb(_, _, 128)));
        preview(&format!("image-{theme}"), &frame);
    }
}
