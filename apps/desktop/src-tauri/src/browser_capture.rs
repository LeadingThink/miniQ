//! Capture the browser's own render surface, without taking over the desktop
//! or requiring screen-recording permission.
#[cfg(any(windows, target_os = "macos"))]
use base64::Engine;
use tauri::Manager;

#[cfg(target_os = "macos")]
#[path = "browser_capture/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "browser_capture/windows.rs"]
mod platform;

pub async fn capture(app: &tauri::AppHandle, view_id: &str) -> Result<String, String> {
    let webview = app
        .get_webview(&super::browser_label(view_id)?)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    #[cfg(any(windows, target_os = "macos"))]
    {
        let png = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            platform::capture(webview),
        )
        .await
        .map_err(|_| "内嵌浏览器截图超时".to_string())??;
        if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("内嵌浏览器未返回有效的 PNG 截图".into());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(png))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = webview;
        Err("此平台尚不支持内嵌浏览器截图".into())
    }
}
