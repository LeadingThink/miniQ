use tauri::{
    webview::NewWindowResponse, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

fn browser_label(view_id: &str) -> Result<String, String> {
    if view_id.is_empty()
        || view_id.len() > 64
        || !view_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid browser instance identifier".into());
    }
    Ok(format!("miniq-browser-{view_id}"))
}

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
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("内置浏览器只允许不含账号密码的 HTTP(S) 页面".into());
    }
    Ok(url)
}

fn validate_bounds(bounds: BrowserBounds) -> Result<(), String> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err("browser bounds must be finite".into());
    }
    if bounds.width < 0.0 || bounds.height < 0.0 {
        return Err("browser dimensions cannot be negative".into());
    }
    Ok(())
}

fn resize(webview: &tauri::Webview, bounds: BrowserBounds) -> Result<(), String> {
    validate_bounds(bounds)?;
    if bounds.width < 1.0 || bounds.height < 1.0 {
        return Ok(());
    }
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|error| error.to_string())
}

pub fn open(
    app: &tauri::AppHandle,
    view_id: &str,
    value: &str,
    bounds: BrowserBounds,
) -> Result<BrowserState, String> {
    validate_bounds(bounds)?;
    let url = parse_url(value)?;
    let label = browser_label(view_id)?;
    if let Some(webview) = app.get_webview(&label) {
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
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .on_navigation(|target| {
            matches!(target.scheme(), "http" | "https")
                && target.username().is_empty()
                && target.password().is_none()
        })
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

pub fn resize_current(
    app: &tauri::AppHandle,
    view_id: &str,
    bounds: BrowserBounds,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(view_id)?) {
        resize(&webview, bounds)?;
    }
    Ok(())
}

pub fn action(app: &tauri::AppHandle, view_id: &str, action: &str) -> Result<BrowserState, String> {
    let webview = app
        .get_webview(&browser_label(view_id)?)
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

pub fn current(app: &tauri::AppHandle, view_id: &str) -> Result<BrowserState, String> {
    let webview = app
        .get_webview(&browser_label(view_id)?)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    Ok(BrowserState {
        url: webview
            .url()
            .map_err(|error| error.to_string())?
            .to_string(),
    })
}

pub fn close(app: &tauri::AppHandle, view_id: &str) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(view_id)?) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn set_visible(app: &tauri::AppHandle, view_id: &str, visible: bool) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(view_id)?) {
        if visible {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_nonfinite_or_negative_initial_bounds() {
        for width in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(validate_bounds(BrowserBounds {
                x: 0.0,
                y: 0.0,
                width,
                height: 100.0
            })
            .is_err());
        }
    }

    #[test]
    fn accepts_only_http_urls() {
        assert_eq!(parse_url("example.com").unwrap().scheme(), "https");
        assert!(parse_url("http://127.0.0.1:3000").is_ok());
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("https://user:password@example.com").is_err());
        assert!(parse_url("https://user@example.com").is_err());
        assert_eq!(
            parse_url("localhost:3000").unwrap().as_str(),
            "https://localhost:3000/"
        );
        assert!(parse_url("http://[::1]:3000").is_ok());
    }

    #[test]
    fn browser_instance_labels_cannot_address_the_main_webview() {
        assert_ne!(browser_label("main").unwrap(), "main");
        assert_ne!(
            browser_label("session-a").unwrap(),
            browser_label("session-b").unwrap()
        );
        for invalid in ["", "../main", "a:b", "a/b"] {
            assert!(browser_label(invalid).is_err());
        }
    }
}
