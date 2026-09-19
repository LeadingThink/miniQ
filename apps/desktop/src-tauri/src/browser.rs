use tauri::{
    webview::NewWindowResponse, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

#[path = "browser_capture.rs"]
mod capture;
pub use capture::capture as screenshot;

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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    navigation_control: bool,
    dom_snapshot: bool,
    screenshot: bool,
    tabs: bool,
    pointer_input: bool,
    keyboard_input: bool,
    select_input: bool,
}

pub fn capabilities() -> BrowserCapabilities {
    BrowserCapabilities {
        navigation_control: cfg!(any(windows, target_os = "macos")),
        dom_snapshot: cfg!(any(windows, target_os = "macos")),
        screenshot: cfg!(any(windows, target_os = "macos")),
        tabs: false,
        pointer_input: cfg!(any(windows, target_os = "macos")),
        keyboard_input: cfg!(any(windows, target_os = "macos")),
        select_input: cfg!(any(windows, target_os = "macos")),
    }
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
    let bounds = viewport_bounds(webview.app_handle(), bounds)?;
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|error| error.to_string())
}

fn viewport_bounds(app: &tauri::AppHandle, bounds: BrowserBounds) -> Result<BrowserBounds, String> {
    #[cfg(target_os = "macos")]
    {
        let main = app
            .get_webview("main")
            .ok_or_else(|| "找不到 miniQ 主页面".to_string())?;
        let scale = main
            .window()
            .scale_factor()
            .map_err(|error| error.to_string())?;
        let origin = main
            .bounds()
            .map_err(|error| error.to_string())?
            .position
            .to_logical::<f64>(scale);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        main.with_webview(move |platform| {
            let view: &objc2_web_kit::WKWebView = unsafe { &*platform.inner().cast() };
            let safe_area = view.safeAreaInsets();
            let _ = sender.send((safe_area.left, safe_area.top));
        })
        .map_err(|error| error.to_string())?;
        // Wry runs with_webview immediately on the main thread and dispatches
        // it there for worker callers, matching its synchronous bounds getter.
        let (left, top) = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "无法读取主页面显示区域".to_string())?;
        // DOM client rects start below WKWebView's safe area. Child WebViews
        // use the window content view, including that area. Read the actual
        // insets each time so titlebars/fullscreen changes stay aligned.
        Ok(BrowserBounds {
            x: origin.x + left + bounds.x,
            y: origin.y + top + bounds.y,
            ..bounds
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(bounds)
    }
}

fn initial_size(bounds: BrowserBounds) -> LogicalSize<f64> {
    if bounds.width < 1.0 || bounds.height < 1.0 {
        LogicalSize::new(1280.0, 720.0)
    } else {
        LogicalSize::new(bounds.width, bounds.height)
    }
}

/// WKWebView hands us the JavaScript string itself, while WebView2 returns a
/// JSON-encoded JavaScript result. Keep both adapters on the same two-level
/// protocol so the caller can decode the outer result and then the observation.
#[cfg(target_os = "macos")]
fn encode_webkit_script_string(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("内嵌浏览器脚本结果编码失败: {error}"))
}

pub fn open(
    app: &tauri::AppHandle,
    view_id: &str,
    value: &str,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<BrowserState, String> {
    validate_bounds(bounds)?;
    let url = parse_url(value)?;
    let label = browser_label(view_id)?;
    if let Some(webview) = app.get_webview(&label) {
        resize(&webview, bounds)?;
        if visible {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|error| error.to_string())?;
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
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("browser-sessions")
        .join(&label);
    std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let navigation_app = app.clone();
    let navigation_label = label.clone();
    // Start at the requested remote page. Loading the application shell first
    // exposes an unrelated complete document before remote navigation commits.
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .initialization_script(include_str!("browser_links.js"))
        .data_directory(data_directory)
        .incognito(true)
        .on_navigation(|target| {
            matches!(target.scheme(), "http" | "https")
                && target.username().is_empty()
                && target.password().is_none()
        })
        .on_new_window(move |target, _| {
            if matches!(target.scheme(), "http" | "https")
                && target.username().is_empty()
                && target.password().is_none()
            {
                let app = navigation_app.clone();
                let label = navigation_label.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Some(webview) = app.get_webview(&label) {
                        if let Err(error) = webview.navigate(target) {
                            eprintln!("[miniq] embedded link navigation failed: {error}");
                        }
                    }
                });
            }
            NewWindowResponse::Deny
        });
    let native_bounds = viewport_bounds(app, bounds)?;
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(native_bounds.x, native_bounds.y),
            initial_size(bounds),
        )
        .map_err(|error| error.to_string())?;
    if !visible {
        webview.hide().map_err(|error| error.to_string())?;
    }
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

#[cfg(windows)]
pub async fn evaluate(
    app: &tauri::AppHandle,
    view_id: &str,
    script: String,
) -> Result<String, String> {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;

    let webview = app
        .get_webview(&browser_label(view_id)?)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform| {
            let callback_sender = sender.clone();
            let result = unsafe {
                platform.controller().CoreWebView2().and_then(|webview| {
                    let handler =
                        ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
                            if let Some(sender) = callback_sender
                                .lock()
                                .ok()
                                .and_then(|mut value| value.take())
                            {
                                let _ = sender.send(
                                    status.map(|_| result).map_err(|error| error.to_string()),
                                );
                            }
                            Ok(())
                        }));
                    webview.ExecuteScript(&HSTRING::from(script), &handler)
                })
            };
            if let Err(error) = result {
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ = sender.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "内嵌浏览器脚本执行超时".to_string())?
        .map_err(|_| "内嵌浏览器脚本执行通道已关闭".to_string())?
}

#[cfg(not(windows))]
pub async fn evaluate(
    app: &tauri::AppHandle,
    view_id: &str,
    script: String,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2_foundation::{NSError, NSString};

        let webview = app
            .get_webview(&browser_label(view_id)?)
            .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
        webview
            .with_webview(move |platform| {
                let callback_sender = sender.clone();
                let completion =
                    RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                        let outcome = if !error.is_null() {
                            // WKWebView reports JavaScript exceptions and
                            // navigation failures through NSError.  Preserve
                            // the localized message so the caller can decide
                            // whether to retry or refresh the observation.
                            Err(unsafe { (&*error).to_string() })
                        } else if result.is_null() {
                            // `undefined` is represented by nil by WebKit. The
                            // automation contract requires a JSON string, so
                            // surface this as a recoverable driver error rather
                            // than handing the parser a misleading null value.
                            Err("内嵌浏览器脚本未返回字符串结果".to_string())
                        } else {
                            // browserAutomationScript deliberately returns
                            // JSON.stringify(...), so the WebKit result is an
                            // NSString. Validate the runtime class before
                            // downcasting; NSObject::description would change
                            // escaped JSON and break the observation parser.
                            let object = unsafe { &*result };
                            object
                                .downcast_ref::<NSString>()
                                .ok_or_else(|| "内嵌浏览器返回了非字符串脚本结果".to_string())
                                .and_then(|value| encode_webkit_script_string(&value.to_string()))
                        };
                        if let Some(sender) = callback_sender
                            .lock()
                            .ok()
                            .and_then(|mut value| value.take())
                        {
                            let _ = sender.send(outcome);
                        }
                    });
                // `inner` is owned by Tauri/Wry; this borrowed view remains
                // valid for the duration of the main-thread callback.
                let view: &objc2_web_kit::WKWebView = unsafe { &*platform.inner().cast() };
                let java_script = NSString::from_str(&script);
                unsafe {
                    view.evaluateJavaScript_completionHandler(&java_script, Some(&completion));
                }
            })
            .map_err(|error| error.to_string())?;
        return tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
            .await
            .map_err(|_| "内嵌浏览器脚本执行超时".to_string())?
            .map_err(|_| "内嵌浏览器脚本执行通道已关闭".to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, view_id, script);
        Err("此平台尚不支持内嵌浏览器 DOM 自动化".into())
    }
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
    fn hidden_browser_uses_an_automation_ready_initial_viewport() {
        let size = initial_size(BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
        assert_eq!(size.width, 1280.0);
        assert_eq!(size.height, 720.0);

        let visible = initial_size(BrowserBounds {
            x: 10.0,
            y: 20.0,
            width: 900.0,
            height: 600.0,
        });
        assert_eq!(visible.width, 900.0);
        assert_eq!(visible.height, 600.0);
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

    #[cfg(target_os = "macos")]
    #[test]
    fn webkit_script_result_preserves_unicode_and_quotes_in_outer_protocol() {
        let inner = r#"{"title":"联想之星创业 \"问卷\"","line":"第一行\n第二行"}"#;
        let encoded = encode_webkit_script_string(inner).unwrap();
        let decoded_outer: String = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded_outer, inner);
        let value: serde_json::Value = serde_json::from_str(&decoded_outer).unwrap();
        assert_eq!(value["title"], "联想之星创业 \"问卷\"");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_browser_advertises_dom_and_native_screenshot_support() {
        let flags = capabilities();
        assert!(flags.navigation_control);
        assert!(flags.dom_snapshot);
        assert!(flags.pointer_input);
        assert!(flags.keyboard_input);
        assert!(flags.select_input);
        assert!(flags.screenshot);
    }
}
