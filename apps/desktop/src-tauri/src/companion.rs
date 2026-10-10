//! Optional desktop companion. All window labels and destinations are fixed here.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};

const LABEL: &str = "companion";
const PREFS_FILE: &str = "companion-prefs.json";
const COLLAPSED: (f64, f64) = (104.0, 112.0);
const EXPANDED: (f64, f64) = (360.0, 540.0);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Hidden,
    Dots,
    Pet,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    position: Option<Point>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Point {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Default)]
pub struct CompanionState(Mutex<Prefs>);

pub(crate) fn authorized(label: &str) -> Result<(), String> {
    if matches!(label, "main" | LABEL) {
        Ok(())
    } else {
        Err("Companion commands require the main or companion window".into())
    }
}

/// App commands are unrestricted by Tauri unless build.rs generates their ACL.
/// Explicitly guard this window before the existing generated invoke handler.
pub(crate) fn allowed_command(command: &str) -> bool {
    matches!(
        command,
        "daemon_connection"
            | "companion_get_prefs"
            | "companion_set_mode"
            | "companion_expand"
            | "companion_open_main"
    )
}

fn read_prefs(app: &tauri::AppHandle) -> Prefs {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read(dir.join(PREFS_FILE)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_prefs(app: &tauri::AppHandle, prefs: &Prefs) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Keep configuration separate from daemon preferences and sound settings.
    let tmp = dir.join("companion-prefs.tmp");
    std::fs::write(&tmp, serde_json::to_vec(prefs).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join(PREFS_FILE)).map_err(|e| e.to_string())
}

// Physical desktop coordinates support monitors left/above the primary display.
// Clamp the full window to the nearest monitor's work area after unplugging one.
fn clamp_position(point: Point, size: (u32, u32), monitors: &[Bounds]) -> Point {
    monitors
        .iter()
        .map(|b| {
            let right = (i64::from(b.x) + i64::from(b.width.saturating_sub(size.0)))
                .min(i64::from(i32::MAX));
            let bottom = (i64::from(b.y) + i64::from(b.height.saturating_sub(size.1)))
                .min(i64::from(i32::MAX));
            let p = Point {
                x: i64::from(point.x).clamp(i64::from(b.x), right) as i32,
                y: i64::from(point.y).clamp(i64::from(b.y), bottom) as i32,
            };
            let distance = (i128::from(p.x) - i128::from(point.x)).pow(2)
                + (i128::from(p.y) - i128::from(point.y)).pow(2);
            (distance, p)
        })
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, p)| p)
        .unwrap_or(Point { x: 0, y: 0 })
}

fn fit_window(window: &WebviewWindow, expanded: bool, saved: Option<Point>) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let bounds: Vec<_> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Bounds {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect();
    let current = window.outer_position().map_err(|e| e.to_string())?;
    let point = saved.unwrap_or(Point {
        x: current.x,
        y: current.y,
    });
    // Find the nearest work area first, then apply that monitor's scale and size.
    let nearest = clamp_position(point, (1, 1), &bounds);
    let target = monitors.iter().find(|m| {
        let b = m.work_area();
        i64::from(nearest.x) >= i64::from(b.position.x)
            && i64::from(nearest.x) < i64::from(b.position.x) + i64::from(b.size.width)
            && i64::from(nearest.y) >= i64::from(b.position.y)
            && i64::from(nearest.y) < i64::from(b.position.y) + i64::from(b.size.height)
    });
    let scale = target
        .map(|m| m.scale_factor())
        .unwrap_or(window.scale_factor().map_err(|e| e.to_string())?);
    let logical = if expanded { EXPANDED } else { COLLAPSED };
    let mut size = (
        (logical.0 * scale).round() as u32,
        (logical.1 * scale).round() as u32,
    );
    let point = if let Some(monitor) = target {
        let b = monitor.work_area();
        size = (size.0.min(b.size.width), size.1.min(b.size.height));
        clamp_position(
            point,
            size,
            &[Bounds {
                x: b.position.x,
                y: b.position.y,
                width: b.size.width,
                height: b.size.height,
            }],
        )
    } else {
        clamp_position(point, size, &bounds)
    };
    window
        .set_size(PhysicalSize::new(size.0, size.1))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(point.x, point.y))
        .map_err(|e| e.to_string())
}

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let prefs = read_prefs(app);
    *app.state::<CompanionState>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = prefs.clone();
    if prefs.mode != Mode::Hidden {
        show(app)?;
    }
    Ok(())
}

pub(crate) fn show(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<CompanionState>();
    let mut prefs = state.0.lock().map_err(|e| e.to_string())?;
    if prefs.mode == Mode::Hidden {
        prefs.mode = Mode::Pet; // tray click is explicit opt-in
        save_prefs(app, &prefs)?;
    }
    let position = prefs.position;
    drop(prefs);
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                LABEL,
                WebviewUrl::App("index.html?companion".into()),
            )
            .title("miniQ companion")
            .inner_size(COLLAPSED.0, COLLAPSED.1)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .shadow(false)
            .devtools(cfg!(debug_assertions))
            .on_navigation(|url| {
                let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (matches!(url.scheme(), "http" | "https")
                        && url.host_str() == Some("tauri.localhost"))
                    || (cfg!(debug_assertions)
                        && url.scheme() == "http"
                        && url.host_str() == Some("localhost")
                        && url.port() == Some(1420));
                local && url.query_pairs().any(|(key, _)| key == "companion")
            });
            // macOS transparency requires macos-private-api, which we deliberately
            // do not enable. A regular window with transparent CSS remains usable.
            #[cfg(not(target_os = "macos"))]
            let builder = builder.transparent(true);
            let window = builder.build().map_err(|e| e.to_string())?;
            let handle = app.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Moved(position) = event {
                    let state = handle.state::<CompanionState>();
                    if let Ok(mut prefs) = state.0.lock() {
                        prefs.position = Some(Point {
                            x: position.x,
                            y: position.y,
                        });
                        let _ = save_prefs(&handle, &prefs);
                    };
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if crate::QUIT_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    api.prevent_close();
                    let _ = set_mode(&handle, Mode::Hidden);
                }
            });
            window
        }
    };
    fit_window(&window, false, position)?;
    window.show().map_err(|e| e.to_string())?; // never set_focus on passive show
    app.emit("companion:prefs", snapshot(app)?)
        .map_err(|e| e.to_string())
}

fn snapshot(app: &tauri::AppHandle) -> Result<Prefs, String> {
    Ok(app
        .state::<CompanionState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}

fn set_mode(app: &tauri::AppHandle, mode: Mode) -> Result<Prefs, String> {
    {
        let state = app.state::<CompanionState>();
        let mut prefs = state.0.lock().map_err(|e| e.to_string())?;
        let mut next = prefs.clone();
        next.mode = mode;
        save_prefs(app, &next)?;
        *prefs = next;
    }
    if mode == Mode::Hidden {
        if let Some(window) = app.get_webview_window(LABEL) {
            window.hide().map_err(|e| e.to_string())?;
        }
    } else {
        show(app)?;
    }
    let prefs = snapshot(app)?;
    if mode == Mode::Hidden {
        app.emit("companion:prefs", &prefs)
            .map_err(|e| e.to_string())?;
    }
    Ok(prefs)
}

#[tauri::command]
pub fn companion_get_prefs(app: tauri::AppHandle, window: WebviewWindow) -> Result<Prefs, String> {
    authorized(window.label())?;
    snapshot(&app)
}

#[tauri::command]
pub async fn companion_set_mode(
    app: tauri::AppHandle,
    window: WebviewWindow,
    mode: Mode,
) -> Result<Prefs, String> {
    authorized(window.label())?;
    set_mode(&app, mode)
}

#[tauri::command]
pub fn companion_expand(window: WebviewWindow, expanded: bool) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Only companion can resize itself".into());
    }
    fit_window(&window, expanded, None)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Destination {
    Session {
        session_id: String,
        workspace_id: String,
    },
    Settings,
    Voice {
        workspace_id: String,
        session_id: Option<String>,
    },
}

#[tauri::command]
pub fn companion_open_main(
    app: tauri::AppHandle,
    window: WebviewWindow,
    destination: Destination,
) -> Result<(), String> {
    authorized(window.label())?;
    let ids: Vec<&str> = match &destination {
        Destination::Session {
            session_id,
            workspace_id,
        } => vec![session_id, workspace_id],
        Destination::Voice {
            workspace_id,
            session_id,
        } => std::iter::once(workspace_id.as_str())
            .chain(session_id.as_deref())
            .collect(),
        Destination::Settings => vec![],
    };
    if ids
        .iter()
        .any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
    {
        return Err("Invalid companion destination IDs".into());
    }
    app.emit_to("main", "companion:navigate", destination)
        .map_err(|e| e.to_string())?;
    crate::show_main_window(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn position_survives_negative_monitor_and_unplugging() {
        let monitors = [
            Bounds {
                x: -1920,
                y: -200,
                width: 1920,
                height: 1080,
            },
            Bounds {
                x: 0,
                y: 0,
                width: 1440,
                height: 900,
            },
        ];
        assert_eq!(
            clamp_position(Point { x: -1500, y: -100 }, (104, 112), &monitors),
            Point { x: -1500, y: -100 }
        );
        assert_eq!(
            clamp_position(Point { x: -1500, y: -100 }, (360, 540), &monitors[1..]),
            Point { x: 0, y: 0 }
        );
        assert_eq!(
            clamp_position(Point { x: 1400, y: 890 }, (360, 540), &monitors[1..]),
            Point { x: 1080, y: 360 }
        );
    }
    #[test]
    fn oversized_window_and_empty_monitors_are_bounded() {
        assert_eq!(
            clamp_position(
                Point { x: 50, y: 50 },
                (1000, 1000),
                &[Bounds {
                    x: -10,
                    y: -10,
                    width: 100,
                    height: 100
                }]
            ),
            Point { x: -10, y: -10 }
        );
        assert_eq!(
            clamp_position(Point { x: 99, y: 99 }, (100, 100), &[]),
            Point { x: 0, y: 0 }
        );
    }
    #[test]
    fn extreme_saved_coordinates_do_not_overflow() {
        let monitor = Bounds {
            x: i32::MIN,
            y: i32::MIN,
            width: 1080,
            height: 1920,
        };
        assert_eq!(
            clamp_position(
                Point {
                    x: i32::MAX,
                    y: i32::MAX
                },
                (104, 112),
                &[monitor]
            ),
            Point {
                x: i32::MIN + 976,
                y: i32::MIN + 1808
            }
        );
    }
    #[test]
    fn prefs_and_command_security() {
        assert_eq!(Prefs::default().mode, Mode::Hidden);
        assert!(serde_json::from_str::<Prefs>(r#"{"mode":"unknown"}"#).is_err());
        assert!(authorized("main").is_ok());
        assert!(authorized("companion").is_ok());
        assert!(authorized("browser-1").is_err());
        assert!(!allowed_command("open_local_file"));
        assert!(!allowed_command("browser_evaluate"));
        assert!(allowed_command("companion_open_main"));
    }
}
