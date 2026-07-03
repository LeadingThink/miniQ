//! miniQ desktop shell: window management plus daemon discovery/launch.
//! All agent logic lives in the separate `miniq-daemon` process; the UI talks
//! to it over WebSocket. The shell only hands the connection info to the UI.

mod daemon;

#[tauri::command]
fn daemon_connection() -> Result<daemon::ConnectionInfo, String> {
    daemon::ensure_daemon().map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![daemon_connection])
        .run(tauri::generate_context!())
        .expect("error while running miniQ desktop");
}
