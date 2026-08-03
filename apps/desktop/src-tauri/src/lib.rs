//! miniQ desktop shell: window management plus daemon discovery/launch.
//! All agent logic lives in the separate `miniq-daemon` process; the UI talks
//! to it over WebSocket. The shell only hands the connection info to the UI.

mod daemon;

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            daemon_connection,
            wait_for_daemon_exit
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
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
