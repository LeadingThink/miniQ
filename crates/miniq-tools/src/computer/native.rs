use enigo::{Axis, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Serialize;

use super::input::{Action, Button, ComputerInput, Modifier};
use crate::{observation, ToolContext};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Display {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FocusedWindow {
    pub id: u32,
    pub display_id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub(super) trait DesktopBackend: Send + Sync {
    fn displays(&self) -> Result<Vec<Display>, String>;
    fn capture(&self, id: u32) -> Result<(Display, image::RgbaImage), String>;
    fn focus(&self) -> Result<Option<FocusedWindow>, String>;
    fn perform(
        &self,
        ctx: &ToolContext,
        input: &ComputerInput,
        display: &Display,
        size: (u32, u32),
    ) -> Result<(), String>;
}

pub(super) struct NativeDesktop;

fn display(monitor: &xcap::Monitor) -> Result<Display, xcap::XCapError> {
    Ok(Display {
        id: monitor.id()?,
        name: monitor.name()?,
        x: monitor.x()?,
        y: monitor.y()?,
        width: monitor.width()?,
        height: monitor.height()?,
        primary: monitor.is_primary()?,
    })
}

impl DesktopBackend for NativeDesktop {
    fn displays(&self) -> Result<Vec<Display>, String> {
        xcap::Monitor::all()
            .and_then(|monitors| monitors.iter().map(display).collect())
            .map_err(|error| error.to_string())
    }
    fn capture(&self, id: u32) -> Result<(Display, image::RgbaImage), String> {
        #[cfg(target_os = "macos")]
        if !core_graphics::access::ScreenCaptureAccess.preflight() {
            return Err("Screen Recording permission is not granted to miniq-daemon. Enable it in macOS System Settings > Privacy & Security before retrying.".into());
        }
        let monitor = xcap::Monitor::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|monitor| monitor.id().ok() == Some(id))
            .ok_or("display disconnected")?;
        let image = monitor.capture_image().map_err(|error| {
            format!("screen capture failed; check OS Screen Recording permission: {error}")
        })?;
        Ok((display(&monitor).map_err(|error| error.to_string())?, image))
    }
    fn focus(&self) -> Result<Option<FocusedWindow>, String> {
        for window in xcap::Window::all().map_err(|error| error.to_string())? {
            if window.is_focused().map_err(|error| error.to_string())? {
                let focus = (|| -> Result<FocusedWindow, xcap::XCapError> {
                    Ok(FocusedWindow {
                        id: window.id()?,
                        display_id: window.current_monitor()?.id()?,
                        x: window.x()?,
                        y: window.y()?,
                        width: window.width()?,
                        height: window.height()?,
                    })
                })();
                return focus.map(Some).map_err(|error| error.to_string());
            }
        }
        Ok(None)
    }
    fn perform(
        &self,
        ctx: &ToolContext,
        input: &ComputerInput,
        display: &Display,
        size: (u32, u32),
    ) -> Result<(), String> {
        if input.action == Action::Wait {
            return observation::pause(ctx, input.milliseconds);
        }
        #[cfg(target_os = "linux")]
        if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") {
            return Err(
                "native desktop input currently requires X11; use browser_automation on Wayland"
                    .into(),
            );
        }
        observation::check_cancelled(ctx)?;
        let settings = Settings {
            open_prompt_to_get_permissions: false,
            release_keys_when_dropped: true,
            ..Settings::default()
        };
        let mut enigo = Enigo::new(&settings).map_err(|error| {
            format!("desktop input unavailable; check OS Accessibility permission: {error}")
        })?;
        match input.action {
            Action::Click | Action::DoubleClick | Action::Move | Action::Drag | Action::Scroll => {
                pointer(&mut enigo, ctx, input, display, size)
            }
            Action::Type => enigo
                .text(input.text.as_deref().ok_or("text is required")?)
                .map_err(|error| error.to_string()),
            Action::Key => keypress(&mut enigo, input),
            _ => Err("not a desktop input action".into()),
        }
    }
}

pub(super) fn coordinates(
    display: &Display,
    size: (u32, u32),
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(i32, i32), String> {
    let (x, y) = (x.ok_or("x is required")?, y.ok_or("y is required")?);
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.
        || y < 0.
        || x >= f64::from(size.0)
        || y >= f64::from(size.1)
        || size.0 == 0
        || size.1 == 0
    {
        return Err("coordinates must be inside the latest screenshot".into());
    }
    Ok((
        display.x + (x * f64::from(display.width) / f64::from(size.0)).floor() as i32,
        display.y + (y * f64::from(display.height) / f64::from(size.1)).floor() as i32,
    ))
}

fn pointer(
    enigo: &mut Enigo,
    ctx: &ToolContext,
    input: &ComputerInput,
    display: &Display,
    size: (u32, u32),
) -> Result<(), String> {
    let at = coordinates(display, size, input.x, input.y)?;
    let end = if input.action == Action::Drag {
        coordinates(display, size, input.end_x, input.end_y)?
    } else {
        at
    };
    let button = match input.button {
        Button::Left => enigo::Button::Left,
        Button::Right => enigo::Button::Right,
        Button::Middle => enigo::Button::Middle,
    };
    observation::check_cancelled(ctx)?;
    move_pointer(enigo, at.0, at.1)?;
    match input.action {
        Action::Move => Ok(()),
        Action::Scroll => {
            enigo
                .scroll(input.scroll_x, Axis::Horizontal)
                .map_err(|error| error.to_string())?;
            enigo
                .scroll(input.scroll_y, Axis::Vertical)
                .map_err(|error| error.to_string())
        }
        Action::Drag => {
            enigo
                .button(button, Direction::Press)
                .map_err(|error| error.to_string())?;
            let movement = (1..=10).try_for_each(|step| {
                observation::pause(ctx, 20)?;
                move_pointer(
                    enigo,
                    at.0 + (end.0 - at.0) * step / 10,
                    at.1 + (end.1 - at.1) * step / 10,
                )
            });
            let release = enigo
                .button(button, Direction::Release)
                .map_err(|error| error.to_string());
            movement.and(release)
        }
        _ => {
            enigo
                .button(button, Direction::Click)
                .map_err(|error| error.to_string())?;
            if input.action == Action::DoubleClick {
                observation::pause(ctx, 70)?;
                enigo
                    .button(button, Direction::Click)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
    }
}

fn move_pointer(enigo: &mut Enigo, x: i32, y: i32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = enigo;
        super::windows::move_pointer(x, y)
    }
    #[cfg(not(target_os = "windows"))]
    enigo
        .move_mouse(x, y, enigo::Coordinate::Abs)
        .map_err(|error| error.to_string())
}

fn keypress(enigo: &mut Enigo, input: &ComputerInput) -> Result<(), String> {
    let key = parse_key(input.key.as_deref().ok_or("key is required")?)?;
    let modifiers = input
        .modifiers
        .iter()
        .map(|value| match value {
            Modifier::Ctrl => Key::Control,
            Modifier::Alt => Key::Alt,
            Modifier::Shift => Key::Shift,
            Modifier::Meta => Key::Meta,
        })
        .collect::<Vec<_>>();
    let result = (|| {
        for modifier in &modifiers {
            enigo.key(*modifier, Direction::Press)?;
        }
        enigo.key(key, Direction::Click)
    })();
    let mut release_error = None;
    for modifier in modifiers.into_iter().rev() {
        if let Err(error) = enigo.key(modifier, Direction::Release) {
            release_error = Some(error);
        }
    }
    result
        .and(release_error.map_or(Ok(()), Err))
        .map_err(|error| error.to_string())
}

pub(super) fn parse_key(value: &str) -> Result<Key, String> {
    Ok(match value {
        "Enter" => Key::Return,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Backspace" => Key::Backspace,
        "Delete" => Key::Delete,
        "Space" => Key::Space,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => {
            let mut characters = value.chars();
            let character = characters.next().ok_or("key cannot be empty")?;
            if characters.next().is_some() {
                return Err(
                    "unknown key; use a named key or one character, and separate modifiers".into(),
                );
            }
            Key::Unicode(character)
        }
    })
}
