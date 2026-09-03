use tauri::{
    webview::NewWindowResponse, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

const BROWSER_LABEL: &str = "miniq-browser";

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    url: String,
}

fn parse_url(value: &str) -> Result<tauri::Url, String> {
    let candidate = value.trim();
    let candidate = if candidate.contains("://") {
        candidate.to_string()
    } else {
        format!("https://{candidate}")
    };
    let url = candidate
        .parse::<tauri::Url>()
        .map_err(|error| format!("网址格式无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("内置浏览器只允许 HTTP(S) 页面".into());
    }
    Ok(url)
}

fn resize(webview: &tauri::Webview, bounds: BrowserBounds) -> Result<(), String> {
    if bounds.width < 1.0 || bounds.height < 1.0 {
        return Ok(());
    }
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| error.to_string())
}

pub fn open(
    app: &tauri::AppHandle,
    value: &str,
    bounds: BrowserBounds,
) -> Result<BrowserState, String> {
    let url = parse_url(value)?;
    if let Some(webview) = app.get_webview(BROWSER_LABEL) {
        resize(&webview, bounds)?;
        webview.show().map_err(|error| error.to_string())?;
        webview
            .navigate(url.clone())
            .map_err(|error| error.to_string())?;
        return Ok(BrowserState {
            url: url.to_string(),
        });
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "找不到 miniQ 主窗口".to_string())?;
    let builder = WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(url.clone()))
        .on_navigation(|target| matches!(target.scheme(), "http" | "https"))
        .on_new_window(|_, _| NewWindowResponse::Deny);
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| error.to_string())?;
    Ok(BrowserState {
        url: url.to_string(),
    })
}

pub fn resize_current(app: &tauri::AppHandle, bounds: BrowserBounds) -> Result<(), String> {
    if let Some(webview) = app.get_webview(BROWSER_LABEL) {
        resize(&webview, bounds)?;
    }
    Ok(())
}

pub fn action(app: &tauri::AppHandle, action: &str) -> Result<BrowserState, String> {
    let webview = app
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    match action {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        "stop" => webview.eval("window.stop()"),
        _ => return Err(format!("未知浏览器操作: {action}")),
    }
    .map_err(|error| error.to_string())?;
    let url = webview.url().map_err(|error| error.to_string())?;
    Ok(BrowserState {
        url: url.to_string(),
    })
}

pub fn current(app: &tauri::AppHandle) -> Result<BrowserState, String> {
    let webview = app
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    Ok(BrowserState {
        url: webview
            .url()
            .map_err(|error| error.to_string())?
            .to_string(),
    })
}

pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(BROWSER_LABEL) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_http_urls() {
        assert_eq!(parse_url("example.com").unwrap().scheme(), "https");
        assert!(parse_url("http://127.0.0.1:3000").is_ok());
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
    }
}
