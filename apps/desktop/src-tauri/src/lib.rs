//! miniQ desktop shell: window management plus daemon discovery/launch.
//! All agent logic lives in the separate `miniq-daemon` process; the UI talks
//! to it over WebSocket. The shell only hands the connection info to the UI.

mod browser;
mod daemon;
mod daemon_process;
mod html_preview;
mod local_file;

type DaemonState = std::sync::Arc<daemon::DaemonLifecycle>;

#[tauri::command]
async fn daemon_connection(
    state: tauri::State<'_, DaemonState>,
) -> Result<daemon::ConnectionInfo, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.ensure())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn prepare_daemon_update(state: tauri::State<'_, DaemonState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.prepare_update())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn cancel_daemon_update(state: tauri::State<'_, DaemonState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.cancel_update())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wait_for_daemon_exit(state: tauri::State<'_, DaemonState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.wait_for_exit())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_local_file(
    app: tauri::AppHandle,
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
) -> Result<(), String> {
    local_file::open(&app, &path, &workspace_path, &workspace_paths)
}

#[tauri::command]
fn reveal_local_file(
    app: tauri::AppHandle,
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
) -> Result<(), String> {
    local_file::reveal(&app, &path, &workspace_path, &workspace_paths)
}

#[tauri::command]
fn read_local_text_file(
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
) -> Result<local_file::LocalTextFile, String> {
    local_file::read_text(&path, &workspace_path, &workspace_paths)
}

#[tauri::command]
fn read_local_file_preview(
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
) -> Result<local_file::LocalFilePreview, String> {
    local_file::read_preview(&path, &workspace_path, &workspace_paths)
}

#[tauri::command]
fn read_image_preview(path: String) -> Result<local_file::LocalImagePreview, String> {
    local_file::read_image_preview(&path)
}

#[tauri::command]
async fn open_html_preview(
    state: tauri::State<'_, html_preview::HtmlPreviews>,
    path: String,
    workspace_path: String,
    workspace_paths: Vec<String>,
    network: bool,
) -> Result<html_preview::PreviewHandle, String> {
    state
        .open(&path, &workspace_path, &workspace_paths, network)
        .await
}

#[tauri::command]
fn close_html_preview(
    state: tauri::State<'_, html_preview::HtmlPreviews>,
    id: String,
) -> Result<(), String> {
    state.close(&id)
}

#[tauri::command]
fn save_pasted_image(
    app: tauri::AppHandle,
    mime_type: String,
    data_base64: String,
) -> Result<String, String> {
    local_file::save_pasted_image(&app, &mime_type, &data_base64)
}

#[tauri::command]
fn browser_open(
    app: tauri::AppHandle,
    view_id: String,
    url: String,
    bounds: browser::BrowserBounds,
) -> Result<browser::BrowserState, String> {
    browser::open(&app, &view_id, &url, bounds)
}

#[tauri::command]
fn browser_resize(
    app: tauri::AppHandle,
    view_id: String,
    bounds: browser::BrowserBounds,
) -> Result<(), String> {
    browser::resize_current(&app, &view_id, bounds)
}

#[tauri::command]
fn browser_action(
    app: tauri::AppHandle,
    view_id: String,
    action: String,
) -> Result<browser::BrowserState, String> {
    browser::action(&app, &view_id, &action)
}

#[tauri::command]
fn browser_current(
    app: tauri::AppHandle,
    view_id: String,
) -> Result<browser::BrowserState, String> {
    browser::current(&app, &view_id)
}

#[tauri::command]
fn browser_close(app: tauri::AppHandle, view_id: String) -> Result<(), String> {
    browser::close(&app, &view_id)
}

#[tauri::command]
fn browser_set_visible(
    app: tauri::AppHandle,
    view_id: String,
    visible: bool,
) -> Result<(), String> {
    browser::set_visible(&app, &view_id, visible)
}

pub fn run() {
    tauri::Builder::default()
        .manage(DaemonState::default())
        .manage(html_preview::HtmlPreviews::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            daemon_connection,
            prepare_daemon_update,
            cancel_daemon_update,
            wait_for_daemon_exit,
            open_local_file,
            reveal_local_file,
            read_local_text_file,
            read_local_file_preview,
            open_html_preview,
            close_html_preview,
            read_image_preview,
            save_pasted_image,
            browser_open,
            browser_resize,
            browser_action,
            browser_current,
            browser_close,
            browser_set_visible
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            setup_global_shortcut(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides to tray; Quit exits from the tray menu.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.hide().is_ok() {
                        api.prevent_close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building miniQ desktop")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main_window(_app);
            }
        });
}

/// Restore the existing window so its session and child webviews stay intact.
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(target_os = "macos")]
    if let Err(error) = app.show() {
        eprintln!("[miniq] could not show application: {error}");
    }
    for result in [window.show(), window.unminimize(), window.set_focus()] {
        if let Err(error) = result {
            eprintln!("[miniq] could not restore main window: {error}");
        }
    }
}

/// Alt+Space toggles the main window from anywhere, mirroring the
/// ChatGPT desktop quick-launch experience.
///
/// Never fails startup: Alt+Space is already taken by the window manager on
/// many Linux desktops (and by the system menu on Windows), so a failed
/// registration only disables the quick-toggle and logs a warning.
fn setup_global_shortcut(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    if let Err(e) = app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, _triggered, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let Some(window) = app.get_webview_window("main") else {
                    return;
                };
                let focused = window.is_focused().unwrap_or(false);
                if window.is_visible().unwrap_or(false) && focused {
                    let _ = window.hide();
                } else {
                    show_main_window(app);
                }
            })
            .build(),
    ) {
        eprintln!("[miniq] global-shortcut unavailable: {e}; continuing without quick-toggle");
        return;
    }

    // Preferred first; fall back when the OS/window-manager already owns it.
    let candidates = [
        Shortcut::new(Some(Modifiers::ALT), Code::Space),
        Shortcut::new(Some(Modifiers::ALT | Modifiers::CONTROL), Code::Space),
    ];
    for shortcut in candidates {
        match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                eprintln!("[miniq] quick-toggle registered: {shortcut}");
                return;
            }
            Err(e) => eprintln!("[miniq] shortcut {shortcut} unavailable: {e}"),
        }
    }
    eprintln!("[miniq] no quick-toggle shortcut available; continuing without it");
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItemBuilder::with_id("show", "Show miniQ").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("miniq-tray")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("miniQ")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
