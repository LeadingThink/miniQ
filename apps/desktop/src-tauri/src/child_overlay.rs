//! Local HTML panels that must paint above embedded remote webviews.
use crate::browser::{self, BrowserBounds};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

pub struct ChildOverlay {
    label: &'static str,
    global: &'static str,
    actions: &'static [&'static str],
    transparent: bool,
    generation: AtomicU64,
}

impl ChildOverlay {
    pub const fn new(
        label: &'static str,
        global: &'static str,
        actions: &'static [&'static str],
        transparent: bool,
    ) -> Self {
        Self {
            label,
            global,
            actions,
            transparent,
            generation: AtomicU64::new(0),
        }
    }

    fn script(&self, snapshot: &serde_json::Value, update: bool) -> String {
        let global = self.global;
        let setter = if update {
            format!("window.__MINIQ_SET_{global}__?.(value);")
        } else {
            String::new()
        };
        format!("{{const value={snapshot};window.__MINIQ_{global}__=value;{setter}}}")
    }

    pub fn attach(
        &'static self,
        app: &tauri::AppHandle,
        bounds: BrowserBounds,
        snapshot: &serde_json::Value,
        visible: bool,
    ) -> Result<(), String> {
        let native = browser::viewport_bounds(app, bounds)?;
        let window = app.get_window("main").ok_or("找不到 miniQ 主窗口")?;
        let action_app = app.clone();
        let builder = WebviewBuilder::new(
            self.label,
            WebviewUrl::App(format!("index.html?{}", self.label).into()),
        )
        .initialization_script(self.script(snapshot, false))
        .transparent(self.transparent)
        .devtools(cfg!(debug_assertions))
        .on_navigation(move |url| {
            if url.scheme() == "miniq-overlay" {
                let action = url.host_str().unwrap_or_default();
                if self.actions.contains(&action) {
                    let _ = action_app.emit_to("main", &format!("{}://action", self.label), action);
                }
                return false;
            }
            self.allows_page(url)
        });
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(native.x, native.y),
                LogicalSize::new(native.width, native.height),
            )
            .map_err(|error| error.to_string())?;
        self.generation
            .store(browser::child_view_attached(), Ordering::SeqCst);
        if !visible {
            webview.hide().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn allows_page(&self, url: &tauri::Url) -> bool {
        let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(1420));
        local && url.query_pairs().any(|(key, _)| key == self.label)
    }

    pub fn open(
        &'static self,
        app: &tauri::AppHandle,
        bounds: BrowserBounds,
        snapshot: serde_json::Value,
    ) -> Result<(), String> {
        browser::validate_bounds(bounds)?;
        if bounds.width < 1.0 || bounds.height < 1.0 {
            return Err("overlay must have a visible size".into());
        }
        if let Some(webview) = app.get_webview(self.label) {
            if self.generation.load(Ordering::SeqCst) == browser::child_view_generation() {
                browser::resize(&webview, bounds)?;
                webview
                    .eval(self.script(&snapshot, true))
                    .map_err(|error| error.to_string())?;
                webview.show().map_err(|error| error.to_string())?;
                if self.transparent {
                    webview.set_focus().map_err(|error| error.to_string())?;
                }
                return Ok(());
            }
            webview.close().map_err(|error| error.to_string())?;
        }
        self.attach(app, bounds, &snapshot, true)?;
        if self.transparent {
            if let Some(webview) = app.get_webview(self.label) {
                webview.set_focus().map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub fn update(
        &self,
        app: &tauri::AppHandle,
        bounds: BrowserBounds,
        snapshot: serde_json::Value,
    ) -> Result<(), String> {
        if let Some(webview) = app.get_webview(self.label) {
            browser::resize(&webview, bounds)?;
            webview
                .eval(self.script(&snapshot, true))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn close(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if let Some(webview) = app.get_webview(self.label) {
            webview.hide().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    static PANEL: ChildOverlay = ChildOverlay::new(
        "platform-overlay",
        "PLATFORM",
        &["close", "zaiwen", "miniq"],
        true,
    );

    #[test]
    fn snapshots_remain_data_and_updates_also_refresh_the_initial_snapshot() {
        let snapshot = serde_json::json!({"error": "quote: \" and newline\n"});
        let script = PANEL.script(&snapshot, true);
        assert!(script.contains(&snapshot.to_string()));
        assert!(script.contains("window.__MINIQ_PLATFORM__=value;"));
        assert!(script.contains("window.__MINIQ_SET_PLATFORM__?.(value);"));
    }

    #[test]
    fn only_the_local_panel_document_can_navigate() {
        for url in [
            "https://chat.zaiwenai.com/?platform-overlay",
            "https://tauri.localhost.evil/?platform-overlay",
            "tauri://localhost/?companion",
        ] {
            assert!(!PANEL.allows_page(&url.parse().unwrap()));
        }
        assert!(PANEL.allows_page(
            &"tauri://localhost/index.html?platform-overlay"
                .parse()
                .unwrap()
        ));
    }
}
