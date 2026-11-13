use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

use crate::browser::{self, BrowserBounds};

const LABEL: &str = "context-usage-overlay";
const EVENT_ACTION: &str = "context-usage-overlay://action";

fn script(snapshot: &serde_json::Value) -> Result<String, String> {
    let value = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
    Ok(format!("window.__MINIQ_CONTEXT_USAGE__={value};"))
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
    close(app)?;
    let native_bounds = browser::viewport_bounds(app, bounds)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "找不到 miniQ 主窗口".to_string())?;
    let action_app = app.clone();
    let builder = WebviewBuilder::new(
        LABEL,
        WebviewUrl::App("index.html?context-usage-overlay".into()),
    )
    .initialization_script(&script(&snapshot)?)
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
    Ok(())
}

pub fn update(app: &tauri::AppHandle, snapshot: serde_json::Value) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    let value = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
    webview
        .eval(format!("window.__MINIQ_SET_CONTEXT_USAGE__?.({value})"))
        .map_err(|error| error.to_string())
}

pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(LABEL) {
        webview.close().map_err(|error| error.to_string())?;
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
}