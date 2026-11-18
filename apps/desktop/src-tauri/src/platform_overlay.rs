use crate::{browser::BrowserBounds, child_overlay::ChildOverlay};
use tauri::{Emitter, Manager};

static PANEL: ChildOverlay = ChildOverlay::new("platform-overlay", "PLATFORM", &[], true);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlatformAction {
    Close,
    Miniq,
    Zaiwen,
}

pub fn allowed_command(label: &str, command: &str) -> bool {
    label == "platform-overlay" && command == "platform_overlay_action"
}

#[tauri::command]
pub fn platform_overlay_action(
    webview: tauri::Webview,
    action: PlatformAction,
) -> Result<(), String> {
    if !allowed_command(webview.label(), "platform_overlay_action") {
        return Err("Platform actions are only available to the platform overlay".into());
    }
    webview
        .app_handle()
        .emit_to("main", "platform-overlay://action", action)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn platform_overlay_open(
    app: tauri::AppHandle,
    bounds: BrowserBounds,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || PANEL.open(&app, bounds, snapshot))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn platform_overlay_close(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || PANEL.close(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_overlay_can_only_send_its_dedicated_action() {
        assert!(allowed_command(
            "platform-overlay",
            "platform_overlay_action"
        ));
        for (label, command) in [
            ("platform-overlay", "browser_open"),
            ("main", "platform_overlay_action"),
            ("miniq-browser-site", "platform_overlay_action"),
        ] {
            assert!(!allowed_command(label, command));
        }
    }

    #[test]
    fn frontend_actions_match_the_native_enum_and_event_payload() {
        for (value, action) in [
            ("close", PlatformAction::Close),
            ("miniq", PlatformAction::Miniq),
            ("zaiwen", PlatformAction::Zaiwen),
        ] {
            let payload = serde_json::json!(value);
            assert_eq!(
                serde_json::from_value::<PlatformAction>(payload.clone()).unwrap(),
                action
            );
            assert_eq!(serde_json::to_value(action).unwrap(), payload);
        }
        assert!(
            serde_json::from_value::<PlatformAction>(serde_json::json!("browser_open")).is_err()
        );
    }
}
