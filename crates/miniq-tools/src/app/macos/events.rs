//! Process-directed events with an isolated source. No HID, activation or clipboard.

use core_graphics::{
    display::CGDisplay,
    event::{CGEvent, CGEventFlags, EventField},
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGPoint,
};
use objc2::rc::{autoreleasepool, Retained};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_core_graphics::{
    CGEvent as WindowEvent, CGEventField, CGEventSource as WindowEventSource,
    CGEventSourceStateID as WindowSourceState, CGEventType as WindowEventType,
};
use objc2_foundation::{NSPoint, NSProcessInfo};

use crate::{
    app::{
        backend::AppWindow,
        input::{Action, AppInput, Modifier},
    },
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

fn window_event(
    target: &AppWindow,
    input: &AppInput,
    point: CGPoint,
    kind: NSEventType,
    source: &WindowEventSource,
) -> Result<Retained<WindowEvent>, String> {
    // The public under-pointer CG fields do not set NSEvent.windowNumber.
    // Let AppKit encode that association through its public constructor; no
    // undocumented event fields or foreground activation are needed.
    let local_x = point.x - target.x as f64;
    let local_top_y = point.y - target.y as f64;
    // This process does not own the destination NSWindow. The factory flips
    // its Cocoa point around the main display; undo that flip so the encoded
    // event carries window-relative top-left coordinates. Destination AppKit
    // then applies its own window-height flip. Observed target bounds handle
    // other displays and negative desktop origins without hardcoded heights.
    let main_height = CGDisplay::main().bounds().size.height;
    if !main_height.is_finite() || main_height <= 0. {
        return Err("application event main-display geometry unavailable".into());
    }
    let local = NSPoint::new(local_x, main_height - local_top_y);
    let native = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind, local, NSEventModifierFlags(flags(&input.modifiers).bits() as usize),
        NSProcessInfo::processInfo().systemUptime(), target.window_id as isize,
        None, 0, 1, if kind == NSEventType::LeftMouseDown { 1. } else { 0. },
    ).ok_or("cannot create window-bound AppKit event")?;
    let event = native
        .CGEvent()
        .ok_or("AppKit event has no Quartz representation")?;
    WindowEvent::set_source(Some(&event), Some(source));
    // Preserve the constructor's window-relative payload. CGEventSetLocation
    // invalidates that encoded position before process-directed delivery.
    WindowEvent::set_integer_value_field(
        Some(&event),
        CGEventField::EventTargetUnixProcessID,
        target.pid.into(),
    );
    for field in [
        CGEventField::MouseEventWindowUnderMousePointer,
        CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent,
    ] {
        WindowEvent::set_integer_value_field(Some(&event), field, target.window_id.into());
    }
    Ok(event)
}

fn pointer_events(
    target: &AppWindow,
    input: &AppInput,
    point: CGPoint,
) -> Result<Vec<Retained<WindowEvent>>, String> {
    let source = WindowEventSource::new(WindowSourceState::Private)
        .ok_or("application event source unavailable")?;
    if input.action == Action::Click {
        return Ok(vec![
            window_event(target, input, point, NSEventType::LeftMouseDown, &source)?,
            window_event(target, input, point, NSEventType::LeftMouseUp, &source)?,
        ]);
    }
    // NSEvent's mouse constructor rejects scrollWheel. Seed a window-bound
    // mouse event, then use public CG APIs to define a discrete scroll event.
    let event = window_event(target, input, point, NSEventType::MouseMoved, &source)?;
    WindowEvent::set_type(Some(&event), WindowEventType::ScrollWheel);
    for (steps, integer, fixed) in [
        (
            input.scroll_y,
            CGEventField::ScrollWheelEventDeltaAxis1,
            CGEventField::ScrollWheelEventFixedPtDeltaAxis1,
        ),
        (
            input.scroll_x,
            CGEventField::ScrollWheelEventDeltaAxis2,
            CGEventField::ScrollWheelEventFixedPtDeltaAxis2,
        ),
    ] {
        let delta = steps
            .checked_neg()
            .ok_or("scroll is outside the native event range")?;
        WindowEvent::set_integer_value_field(Some(&event), integer, delta.into());
        WindowEvent::set_double_value_field(Some(&event), fixed, delta.into());
    }
    WindowEvent::set_integer_value_field(
        Some(&event),
        CGEventField::ScrollWheelEventIsContinuous,
        0,
    );
    Ok(vec![event])
}

pub(super) fn pointer(target: &AppWindow, input: &AppInput, point: CGPoint) -> Result<(), String> {
    autoreleasepool(|_| {
        // Build the complete pair before posting. Cancellation cannot leave a
        // pressed button behind, and no event is sent to the global HID stream.
        for event in pointer_events(target, input, point)? {
            WindowEvent::post_to_pid(target.pid, Some(&event));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_events_roundtrip_with_target_window_and_private_source() {
        autoreleasepool(|_| {
            let target = AppWindow {
                window_id: 12345,
                pid: 123,
                process_instance: "test".into(),
                unavailable_reason: None,
                app_name: "Test".into(),
                title: String::new(),
                x: -200,
                y: 100,
                width: 640,
                height: 480,
            };
            for action in ["click", "scroll"] {
                let input = AppInput::parse(serde_json::json!({
                    "action":action, "windowId":target.window_id, "pid":target.pid,
                    "observationId":"test", "x":30, "y":40, "scrollX":2, "scrollY":3,
                }))
                .unwrap();
                let point = CGPoint::new(-170., 140.);
                let events = pointer_events(&target, &input, point).unwrap();
                assert_eq!(events.len(), if action == "click" { 2 } else { 1 });
                for event in events {
                    let native = NSEvent::eventWithCGEvent(&event).unwrap();
                    assert_eq!(native.windowNumber(), target.window_id as isize);
                    // Receiver AppKit owns the destination window and decodes
                    // this top-left position using that window's own height.
                    assert_eq!(WindowEvent::location(Some(&event)), NSPoint::new(30., 40.));
                    let source_id = WindowEvent::integer_value_field(
                        Some(&event),
                        CGEventField::EventSourceStateID,
                    );
                    // Private creates a unique state table ID, not the -1
                    // creation request constant or either shared table (0/1).
                    assert!(![0, 1].contains(&source_id));
                    assert_eq!(
                        WindowEvent::integer_value_field(
                            Some(&event),
                            CGEventField::EventTargetUnixProcessID
                        ),
                        target.pid as i64
                    );
                    if action == "scroll" {
                        assert_eq!(native.r#type(), NSEventType::ScrollWheel);
                        assert_eq!(
                            (native.scrollingDeltaX(), native.scrollingDeltaY()),
                            (-2., -3.)
                        );
                        assert!(!native.hasPreciseScrollingDeltas());
                    }
                }
            }
        });
    }

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
