use crate::{browser::BrowserBounds, child_overlay::ChildOverlay};
use std::time::Duration;
use tauri::Manager;

static PANEL: ChildOverlay = ChildOverlay::new(
    "context-usage-overlay",
    "CONTEXT_USAGE",
    &["close", "refresh"],
    false,
);

pub fn open(
    app: &tauri::AppHandle,
    bounds: BrowserBounds,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    PANEL.open(app, bounds, snapshot)
}

/// Boot the panel once the main window has settled.
pub fn prewarm(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if app.get_webview("context-usage-overlay").is_some() {
            return;
        }
        let snapshot = serde_json::json!({"usage": null, "loading": true, "error": null});
        let bounds = BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        if let Err(error) = PANEL.attach(&app, bounds, &snapshot, false) {
            eprintln!("[miniq] could not prewarm context usage panel: {error}");
        }
    });
}

pub fn update(
    app: &tauri::AppHandle,
    bounds: BrowserBounds,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    PANEL.update(app, bounds, snapshot)
}

pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    PANEL.close(app)
}
