use super::ax::Element;
use crate::app::backend::AppWindow;
use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use core_graphics::{geometry::CGRect, window};
use std::collections::HashMap;

// Layout from Apple's public sys/proc_info.h, PROC_PIDTBSDINFO.
#[repr(C)]
#[derive(Default)]
struct BsdInfo {
    header: [u32; 12],
    command: [u8; 16],
    name: [u8; 32],
    status: [u32; 6],
    start_seconds: u64,
    start_microseconds: u64,
}

#[link(name = "proc")]
extern "C" {
    fn proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut std::ffi::c_void,
        size: i32,
    ) -> i32;
}

pub(super) fn identity(pid: i32) -> Result<(u64, u64), String> {
    let mut info = BsdInfo::default();
    let size = std::mem::size_of::<BsdInfo>() as i32;
    let returned = unsafe { proc_pidinfo(pid, 3, 0, (&mut info as *mut BsdInfo).cast(), size) };
    if returned != size || info.header[3] != pid as u32 {
        return Err(format!("stale_app_observation: process {pid} exited or its identity is unavailable (OS returned {returned} bytes, expected {size})"));
    }
    Ok((info.start_seconds, info.start_microseconds))
}

fn dictionary(raw: CFTypeRef) -> Result<CFDictionary, String> {
    if raw.is_null() {
        return Err("macOS returned a null window description".into());
    }
    unsafe { CFType::wrap_under_get_rule(raw) }
        .downcast::<CFDictionary>()
        .ok_or_else(|| "macOS returned an invalid window description".into())
}

fn value(info: &CFDictionary, key: &str) -> Option<CFType> {
    info.find(CFString::new(key).as_CFTypeRef())
        .map(|raw| unsafe { CFType::wrap_under_get_rule(*raw) })
}

fn integer(info: &CFDictionary, key: &str) -> Result<i64, String> {
    value(info, key)
        .and_then(|value| value.downcast::<CFNumber>())
        .and_then(|value| value.to_i64())
        .ok_or_else(|| format!("macOS window description is missing {key}"))
}

fn label(info: &CFDictionary, key: &str) -> String {
    // Window titles are optional without Screen Recording. Their absence must
    // not block AX-only discovery, and labels are never used as process identity.
    value(info, key)
        .and_then(|value| value.downcast::<CFString>())
        .map(|value| value.to_string())
        .unwrap_or_default()
}

type ProcessInstances = HashMap<i32, Result<(u64, u64), String>>;

fn describe(info: &CFDictionary, processes: &mut ProcessInstances) -> Result<AppWindow, String> {
    let window_id =
        u32::try_from(integer(info, "kCGWindowNumber")?).map_err(|_| "invalid native window ID")?;
    let pid = i32::try_from(integer(info, "kCGWindowOwnerPID")?)
        .map_err(|_| "invalid window process ID")?;
    let bounds = value(info, "kCGWindowBounds")
        .and_then(|value| value.downcast::<CFDictionary>())
        .and_then(|value| CGRect::from_dict_representation(&value))
        .ok_or("native window bounds unavailable")?;
    let (process_instance, mut unavailable_reason) =
        match processes.entry(pid).or_insert_with(|| identity(pid)) {
            Ok((seconds, microseconds)) => (format!("{seconds}:{microseconds}"), None),
            Err(error) => (String::new(), Some(error.clone())),
        };
    if value(info, "kCGWindowIsOnscreen")
        .and_then(|value| value.downcast::<CFBoolean>())
        .map(bool::from)
        == Some(false)
    {
        unavailable_reason = Some("target window is no longer on screen".into());
    }
    Ok(AppWindow {
        window_id,
        pid,
        process_instance,
        unavailable_reason,
        app_name: label(info, "kCGWindowOwnerName"),
        title: label(info, "kCGWindowName"),
        x: bounds.origin.x as i32,
        y: bounds.origin.y as i32,
        width: bounds.size.width as u32,
        height: bounds.size.height as u32,
    })
}

pub(super) fn list() -> Result<Vec<AppWindow>, String> {
    // One immutable OS snapshot supplies all properties. xcap's per-property
    // getters each re-enumerate every window and make this path quadratic.
    let windows = window::copy_window_info(
        window::kCGWindowListOptionOnScreenOnly | window::kCGWindowListExcludeDesktopElements,
        0,
    )
    .ok_or("native window list unavailable")?;
    let mut processes = ProcessInstances::new();
    windows
        .iter()
        .map(|raw| describe(&dictionary(*raw)?, &mut processes))
        .collect()
}

pub(super) fn resolve(target: &AppWindow) -> Result<(), String> {
    let windows =
        window::copy_window_info(window::kCGWindowListOptionIncludingWindow, target.window_id)
            .ok_or("native target window information unavailable")?;
    let mut processes = ProcessInstances::new();
    let mut current = None;
    for raw in windows.iter() {
        let info = dictionary(*raw)?;
        if integer(&info, "kCGWindowNumber")? == i64::from(target.window_id) {
            current = Some(describe(&info, &mut processes)?);
            break;
        }
    }
    let current =
        current.ok_or("stale_app_observation: target window closed or is no longer visible")?;
    if let Some(error) = current.unavailable_reason {
        return Err(format!("stale_app_observation: {error}"));
    }
    if !current.same_target(target) {
        return Err(
            "stale_app_observation: target window identity or geometry changed; inspect again"
                .into(),
        );
    }
    Ok(())
}

pub(super) fn matches(element: &Element, target: &AppWindow) -> Result<bool, String> {
    let Some((position, size)) = element.bounds()? else {
        return Ok(false);
    };
    Ok(element.pid()? == target.pid
        && (position.x - target.x as f64).abs() < 1.0
        && (position.y - target.y as f64).abs() < 1.0
        && (size.width - target.width as f64).abs() < 1.0
        && (size.height - target.height as f64).abs() < 1.0)
}

pub(super) fn ax_window(application: &Element, target: &AppWindow) -> Result<Element, String> {
    let mut matched = None;
    let mut candidates = application.elements("AXWindows")?;
    // AppKit can expose an attached NSOpenPanel as the focused AXSheet and a
    // separate CGWindow, without including it in AXWindows. It is still an
    // explicit surface returned by the selected application's public AX API.
    if let Some(focused) = application.element("AXFocusedWindow")? {
        if !candidates.contains(&focused) {
            candidates.push(focused)
        }
    }
    for window in candidates {
        if matches(&window, target)? {
            if matched.is_some() {
                return Err("background_target_ambiguous: multiple AX windows have the same bounds; choose a distinct window".into());
            }
            matched = Some(window);
        }
    }
    matched.ok_or_else(|| {
        "background_action_unsupported: target window has no matching accessibility surface".into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> CFDictionary {
        let bounds = CFDictionary::from_CFType_pairs(&[
            (CFString::new("X"), CFNumber::from(-120).as_CFType()),
            (CFString::new("Y"), CFNumber::from(40).as_CFType()),
            (CFString::new("Width"), CFNumber::from(640).as_CFType()),
            (CFString::new("Height"), CFNumber::from(480).as_CFType()),
        ]);
        CFDictionary::from_CFType_pairs(&[
            (
                CFString::new("kCGWindowNumber"),
                CFNumber::from(9).as_CFType(),
            ),
            (
                CFString::new("kCGWindowOwnerPID"),
                CFNumber::from(42).as_CFType(),
            ),
            (
                CFString::new("kCGWindowOwnerName"),
                CFString::new("Fixture").as_CFType(),
            ),
            (CFString::new("kCGWindowBounds"), bounds.as_CFType()),
            (
                CFString::new("kCGWindowIsOnscreen"),
                CFBoolean::true_value().as_CFType(),
            ),
        ])
        .into_untyped()
    }

    #[test]
    fn window_properties_come_from_one_record_and_missing_titles_are_optional() {
        let mut processes = ProcessInstances::from([(42, Ok((123, 456)))]);
        let window = describe(&record(), &mut processes).unwrap();
        assert_eq!((window.window_id, window.pid), (9, 42));
        assert_eq!(window.process_instance, "123:456");
        assert_eq!(
            (window.x, window.y, window.width, window.height),
            (-120, 40, 640, 480)
        );
        assert_eq!(window.app_name, "Fixture");
        assert_eq!(window.title, "");
        assert!(window.unavailable_reason.is_none());
    }

    #[test]
    fn an_unavailable_system_process_does_not_remove_its_window_or_fail_discovery() {
        let mut processes = ProcessInstances::from([(42, Err("identity unavailable".into()))]);
        let window = describe(&record(), &mut processes).unwrap();
        assert_eq!(window.window_id, 9);
        assert!(window.process_instance.is_empty());
        assert_eq!(
            window.unavailable_reason.as_deref(),
            Some("identity unavailable")
        );
    }
}
