//! Process-directed events with an isolated source. No HID, activation or clipboard.

use core_graphics::{
    event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, EventField, ScrollEventUnit},
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGPoint,
};

use crate::{
    app::input::{Action, AppInput, Modifier},
    observation, ToolContext,
};

fn source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::Private)
        .map_err(|()| "application event source unavailable".into())
}

fn flags(modifiers: &[Modifier]) -> CGEventFlags {
    modifiers
        .iter()
        .fold(CGEventFlags::empty(), |flags, modifier| {
            flags
                | match modifier {
                    Modifier::Alt => CGEventFlags::CGEventFlagAlternate,
                    Modifier::Ctrl => CGEventFlags::CGEventFlagControl,
                    Modifier::Meta => CGEventFlags::CGEventFlagCommand,
                    Modifier::Shift => CGEventFlags::CGEventFlagShift,
                }
        })
}

fn keycode(key: &str) -> Result<u16, String> {
    Ok(match key {
        "Enter" | "Return" => 36, "Tab" => 48, "Space" | " " => 49,
        "Escape" => 53, "Backspace" => 51, "Delete" => 117,
        "ArrowLeft" => 123, "ArrowRight" => 124, "ArrowDown" => 125, "ArrowUp" => 126,
        "Home" => 115, "End" => 119, "PageUp" => 116, "PageDown" => 121,
        "F1" => 122, "F2" => 120, "F3" => 99, "F4" => 118, "F5" => 96, "F6" => 97,
        "F7" => 98, "F8" => 100, "F9" => 101, "F10" => 109, "F11" => 103, "F12" => 111,
        _ => match key.to_ascii_lowercase().as_str() {
            "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5, "z" => 6,
            "x" => 7, "c" => 8, "v" => 9, "b" => 11, "q" => 12, "w" => 13,
            "e" => 14, "r" => 15, "y" => 16, "t" => 17, "1" | "!" => 18,
            "2" | "@" => 19, "3" | "#" => 20, "4" | "$" => 21, "6" | "^" => 22,
            "5" | "%" => 23, "=" | "+" => 24, "9" | "(" => 25, "7" | "&" => 26,
            "-" | "_" => 27, "8" | "*" => 28, "0" | ")" => 29, "]" | "}" => 30,
            "o" => 31, "u" => 32, "[" | "{" => 33, "i" => 34, "p" => 35,
            "l" => 37, "j" => 38, "'" | "\"" => 39, "k" => 40, ";" | ":" => 41,
            "\\" | "|" => 42, "," | "<" => 43, "/" | "?" => 44, "n" => 45,
            "m" => 46, "." | ">" => 47, "`" | "~" => 50,
            _ => return Err("background_action_unsupported: key has no native mapping; use type for Unicode text".into()),
        },
    })
}

fn keyboard_pair(
    pid: i32,
    code: u16,
    text: Option<&str>,
    modifiers: CGEventFlags,
) -> Result<(), String> {
    let source = source()?;
    let down = CGEvent::new_keyboard_event(source.clone(), code, true)
        .map_err(|()| "cannot create key-down event")?;
    let up = CGEvent::new_keyboard_event(source, code, false)
        .map_err(|()| "cannot create key-up event")?;
    for event in [&down, &up] {
        event.set_flags(modifiers);
        event.set_integer_value_field(EventField::EVENT_TARGET_UNIX_PROCESS_ID, pid.into());
        if let Some(text) = text {
            event.set_string(text);
        }
    }
    // Both events are prepared first and always paired, even if cancellation arrives.
    down.post_to_pid(pid);
    up.post_to_pid(pid);
    Ok(())
}

pub(super) fn key(pid: i32, input: &AppInput) -> Result<(), String> {
    let key = input.key.as_deref().ok_or("key required")?;
    let mut modifiers = flags(&input.modifiers);
    if key.len() == 1
        && (key.as_bytes()[0].is_ascii_uppercase() || "!@#$%^&*()_+{}|:\"<>?~".contains(key))
    {
        modifiers |= CGEventFlags::CGEventFlagShift;
    }
    // Let macOS derive characters from the virtual key and modifiers. Setting
    // Unicode here would override Shift (e.g. Cmd+Shift+g must resolve to G).
    keyboard_pair(pid, keycode(key)?, None, modifiers)
}

fn unicode_batches(text: &str) -> Result<Vec<String>, String> {
    if text.chars().any(char::is_control) {
        return Err("background_action_unsupported: this editor needs a writable AXValue or AXSelectedText for multiline/control text; no text was inserted".into());
    }
    // Quartz Unicode events are batched on character boundaries, preserving all
    // text including surrogate pairs. Text is never converted to a submit key.
    let mut batch = String::new();
    let mut batches = Vec::new();
    for character in text.chars() {
        if batch.encode_utf16().count() + character.len_utf16() > 20 && !batch.is_empty() {
            batches.push(std::mem::take(&mut batch));
        }
        batch.push(character);
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(batches)
}

pub(super) fn text(
    pid: i32,
    text: &str,
    ctx: &ToolContext,
    validate: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    for batch in unicode_batches(text)? {
        observation::check_cancelled(ctx)?;
        validate()?;
        keyboard_pair(pid, 0, Some(&batch), CGEventFlags::empty())?;
    }
    Ok(())
}

pub(super) fn pointer(
    pid: i32,
    window_id: u32,
    input: &AppInput,
    point: CGPoint,
) -> Result<(), String> {
    let source = source()?;
    let events = if input.action == Action::Click {
        vec![
            CGEvent::new_mouse_event(
                source.clone(),
                CGEventType::LeftMouseDown,
                point,
                CGMouseButton::Left,
            ),
            CGEvent::new_mouse_event(source, CGEventType::LeftMouseUp, point, CGMouseButton::Left),
        ]
    } else {
        let vertical = input
            .scroll_y
            .checked_neg()
            .ok_or("scrollY is outside the native event range")?;
        let horizontal = input
            .scroll_x
            .checked_neg()
            .ok_or("scrollX is outside the native event range")?;
        vec![CGEvent::new_scroll_event(
            source,
            ScrollEventUnit::LINE,
            2,
            vertical,
            horizontal,
            0,
        )]
    };
    let events = events
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|()| "cannot create target pointer events")?;
    for event in &events {
        event.set_location(point);
        event.set_flags(flags(&input.modifiers));
        event.set_integer_value_field(EventField::EVENT_TARGET_UNIX_PROCESS_ID, pid.into());
        event.set_integer_value_field(
            EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER,
            window_id.into(),
        );
        event.set_integer_value_field(
            EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT,
            window_id.into(),
        );
        if input.action == Action::Click {
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 1);
        }
    }
    for event in events {
        event.post_to_pid(pid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_advertised_printable_keys_have_native_mappings() {
        for byte in b' '..=b'~' {
            assert!(keycode(&(byte as char).to_string()).is_ok());
        }
        assert_eq!(keycode("Space").unwrap(), 49);
        assert_eq!(keycode("Enter").unwrap(), 36);
        assert!(keycode("中").is_err());
    }

    #[test]
    fn unicode_batches_preserve_text_at_quartz_utf16_limit() {
        let text = format!("{}中文{}", "a".repeat(19), "🧑‍💻".repeat(14));
        let batches = unicode_batches(&text).unwrap();
        assert_eq!(batches.concat(), text);
        assert!(batches
            .iter()
            .all(|batch| batch.encode_utf16().count() <= 20));
        assert!(unicode_batches("").unwrap().is_empty());
    }

    #[test]
    fn text_never_silently_drops_control_characters_or_submits() {
        for text in ["\nbody", "a\tb", "body\r\nmore", "hidden\0value"] {
            assert!(unicode_batches(text)
                .unwrap_err()
                .contains("no text was inserted"));
        }
        assert!(flags(&[]).is_empty());
    }
}
