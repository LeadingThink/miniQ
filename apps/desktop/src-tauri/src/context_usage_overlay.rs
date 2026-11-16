use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

use crate::browser::{self, BrowserBounds};

const LABEL: &str = "context-usage-overlay";
const EVENT_ACTION: &str = "context-usage-overlay://action";
/// The panel boots its own webview; do it once the main window is settled so
/// startup stays responsive and clicks never pay for it.
const PREWARM_DELAY: Duration = Duration::from_secs(4);
const PREWARM_SNAPSHOT: &str = r#"{"usage":null,"loading":true,"error":null}"#;

/// The main window stacks child views in creation order, so a view attached
/// later paints above this panel. Remember which generation the panel belongs
/// to in order to notice when it may have been covered.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn script(snapshot: &serde_json::Value) -> Result<String, String> {
    let value = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
    Ok(format!("window.__MINIQ_CONTEXT_USAGE__={value};"))
}

fn push(webview: &tauri::Webview, snapshot: &serde_json::Value) -> Result<(), String> {
    let value = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
    webview
        .eval(format!("window.__MINIQ_SET_CONTEXT_USAGE__?.({value})"))
        .map_err(|error| error.to_string())
}

/// Attach the panel webview once. Later opens move and show this instance
/// instead of paying for another webview and page boot.
fn attach(
    app: &tauri::AppHandle,
    bounds: BrowserBounds,
    snapshot: &serde_json::Value,
    visible: bool,
) -> Result<(), String> {
    let native_bounds = browser::viewport_bounds(app, bounds)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "找不到 miniQ 主窗口".to_string())?;
    let action_app = app.clone();
    let builder = WebviewBuilder::new(
        LABEL,
        WebviewUrl::App("index.html?context-usage-overlay".into()),
    )
    .initialization_script(&script(snapshot)?)
    .devtools(cfg!(debug_assertions))
    .on_navigation(move |url| {
        if url.scheme() == "miniq-overlay" {
            let action = url.host_str().unwrap_or_default();
            if matches!(action, "close" | "refresh") {
                let _ = action_app.emit_to("main", EVENT_ACTION, action);
            }
            return false;
        }
        let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(1420));
        local
            && url
                .query_pairs()
                .any(|(key, _)| key == "context-usage-overlay")
    });
    window
        .add_child(
            builder,
            LogicalPosition::new(native_bounds.x, native_bounds.y),
            LogicalSize::new(native_bounds.width, native_bounds.height),
        )
        .map_err(|error| error.to_string())?;
    GENERATION.store(browser::child_view_generation(), Ordering::SeqCst);
    if visible {
        return Ok(());
    }
    let webview = app
        .get_webview(LABEL)
        .ok_or_else(|| "上下文用量面板未创建".to_string())?;
    webview.hide().map_err(|error| error.to_string())
}

pub fn open(
    app: &tauri::AppHandle,
    bounds: BrowserBounds,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    browser::validate_bounds(bounds)?;
    if bounds.width < 1.0 || bounds.height < 1.0 {
        return Err("context usage overlay must have a visible size".into());
    }
    if let Some(webview) = app.get_webview(LABEL) {
        if GENERATION.load(Ordering::SeqCst) == browser::child_view_generation() {
            browser::resize(&webview, bounds)?;
            webview.show().map_err(|error| error.to_string())?;
            return push(&webview, &snapshot);
        }
        // A browser view was attached after the panel, so it would paint over
        // it; rebuild the panel to bring it back to the top.
        webview.close().map_err(|error| error.to_string())?;
    }
    attach(app, bounds, &snapshot, true)
}

/// Boot the panel webview while the app is idle so the first click is instant.
pub fn prewarm(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PREWARM_DELAY).await;
        if app.get_webview(LABEL).is_some() {
            return;
        }
        let snapshot = serde_json::from_str(PREWARM_SNAPSHOT).expect("valid prewarm snapshot");
        let bounds = BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        if let Err(error) = attach(&app, bounds, &snapshot, false) {
            eprintln!("[miniq] could not prewarm context usage panel: {error}");
        }
    });
}

/// Pushes a new snapshot and resizes the overlay to fit the content it renders.
pub fn update(
    app: &tauri::AppHandle,
    bounds: BrowserBounds,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    browser::resize(&webview, bounds)?;
    push(&webview, &snapshot)
}

/// Hide the panel and keep its webview warm for the next open.
pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(LABEL) {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::script;

    #[test]
    fn snapshot_script_preserves_structured_data() {
        let snapshot = serde_json::json!({"error": "quote: \" and newline\n"});
        let output = script(&snapshot).unwrap();
        assert_eq!(
            output,
            "window.__MINIQ_CONTEXT_USAGE__={\"error\":\"quote: \\\" and newline\\n\"};"
        );
    }

    #[test]
    fn prewarm_snapshot_matches_the_panel_placeholder() {
        let snapshot: serde_json::Value =
            serde_json::from_str(super::PREWARM_SNAPSHOT).expect("valid snapshot");
        assert_eq!(snapshot["usage"], serde_json::Value::Null);
        assert_eq!(snapshot["loading"], serde_json::Value::Bool(true));
        assert_eq!(snapshot["error"], serde_json::Value::Null);
    }
}
