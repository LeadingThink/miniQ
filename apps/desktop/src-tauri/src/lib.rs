//! miniQ desktop shell: window management plus daemon discovery/launch.
//! All agent logic lives in the separate `miniq-daemon` process; the UI talks
//! to it over WebSocket. The shell only hands the connection info to the UI.

mod browser;
mod daemon;
mod local_file;

#[tauri::command]
fn daemon_connection() -> Result<daemon::ConnectionInfo, String> {
    daemon::ensure_daemon().map_err(|e| e.to_string())
}

#[tauri::command]
async fn wait_for_daemon_exit() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(daemon::wait_for_exit)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_local_file(
    app: tauri::AppHandle,
    path: String,
    workspace_path: String,
) -> Result<(), String> {
    local_file::open(&app, &path, &workspace_path)
}

#[tauri::command]
fn reveal_local_file(
    app: tauri::AppHandle,
    path: String,
    workspace_path: String,
) -> Result<(), String> {
    local_file::reveal(&app, &path, &workspace_path)
}

#[tauri::command]
fn read_local_text_file(
    path: String,
    workspace_path: String,
) -> Result<local_file::LocalTextFile, String> {
    local_file::read_text(&path, &workspace_path)
}

#[tauri::command]
fn read_local_file_preview(
    path: String,
    workspace_path: String,
) -> Result<local_file::LocalFilePreview, String> {
    local_file::read_preview(&path, &workspace_path)
}

#[tauri::command]
fn browser_open(
    app: tauri::AppHandle,
    url: String,
    bounds: browser::BrowserBounds,
) -> Result<browser::BrowserState, String> {
    browser::open(&app, &url, bounds)
}

#[tauri::command]
fn browser_resize(
    app: tauri::AppHandle,
    bounds: browser::BrowserBounds,
) -> Result<(), String> {
    browser::resize_current(&app, bounds)
}

#[tauri::command]
fn browser_action(
    app: tauri::AppHandle,
    action: String,
) -> Result<browser::BrowserState, String> {
    browser::action(&app, &action)
}

#[tauri::command]
fn browser_current(app: tauri::AppHandle) -> Result<browser::BrowserState, String> {
    browser::current(&app)
}

#[tauri::command]
fn browser_close(app: tauri::AppHandle) -> Result<(), String> {
    browser::close(&app)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            daemon_connection,
            wait_for_daemon_exit,
            open_local_file,
            reveal_local_file,
            read_local_text_file,
            read_local_file_preview,
            browser_open,
            browser_resize,
            browser_action,
            browser_current,
            browser_close
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            setup_global_shortcut(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides to tray; Quit exits from the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running miniQ desktop");
}

/// Alt+Space toggles the main window from anywhere, mirroring the
/// ChatGPT desktop quick-launch experience.
fn setup_global_shortcut(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::Manager;
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_shortcut(shortcut)
            .map_err(|e| tauri::Error::Anyhow(e.into()))?
            .with_handler(move |app, triggered, event| {
                if triggered != &shortcut || event.state() != ShortcutState::Pressed {
                    return;
                }
                let Some(window) = app.get_webview_window("main") else {
                    return;
                };
                let focused = window.is_focused().unwrap_or(false);
                if window.is_visible().unwrap_or(false) && focused {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            })
            .build(),
    )?;
    Ok(())
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;
    use tauri::Manager;

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
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
