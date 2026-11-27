//! DOM automation uses the same result and error contract on every desktop engine.
use tauri::Manager;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    navigation_control: bool,
    pub(crate) dom_snapshot: bool,
    element_locators: bool,
    screenshot: bool,
    tabs: bool,
    pointer_input: bool,
    independent_pointer: bool,
    keyboard_input: bool,
    select_input: bool,
}

impl BrowserCapabilities {
    fn for_platform(platform: &str) -> Self {
        let dom = matches!(platform, "windows" | "macos" | "linux");
        Self {
            navigation_control: dom,
            dom_snapshot: dom,
            element_locators: dom,
            screenshot: matches!(platform, "windows" | "macos"),
            tabs: false,
            pointer_input: dom,
            independent_pointer: dom,
            keyboard_input: dom,
            select_input: dom,
        }
    }
}

pub fn capabilities() -> BrowserCapabilities {
    BrowserCapabilities::for_platform(std::env::consts::OS)
}

/// Catch script errors explicitly: WebView2 otherwise reports them as JSON null.
fn wrap_script(script: &str) -> String {
    format!(
        r#"(() => {{
            try {{
                const value = {script};
                if (typeof value !== "string") throw new Error("内嵌浏览器脚本未返回字符串结果");
                return {{ value }};
            }} catch (error) {{
                return {{ error: String(error?.message ?? error) }};
            }}
        }})()"#
    )
}

fn decode_result(raw: &str) -> Result<String, String> {
    let result: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| format!("内嵌浏览器脚本结果无效: {error}"))?;
    if let Some(error) = result["error"].as_str() {
        return Err(error.to_owned());
    }
    let value = result["value"]
        .as_str()
        .ok_or("内嵌浏览器脚本未返回字符串结果")?;
    // Preserve the existing outer JSON string / inner observation contract.
    serde_json::to_string(value).map_err(|error| error.to_string())
}

pub async fn evaluate(
    app: &tauri::AppHandle,
    view_id: &str,
    script: String,
) -> Result<String, String> {
    if !capabilities().dom_snapshot {
        return Err("此平台尚不支持内嵌浏览器 DOM 自动化".into());
    }
    let webview = app
        .get_webview(&super::browser_label(view_id)?)
        .ok_or("内置浏览器尚未打开")?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Mutex::new(Some(sender));
    webview
        .eval_with_callback(wrap_script(&script), move |raw| {
            if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                let _ = sender.send(decode_result(&raw));
            }
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "内嵌浏览器脚本执行超时".to_string())?
        .map_err(|_| "内嵌浏览器脚本执行通道已关闭".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_engines_support_locators_without_requiring_screenshots() {
        for platform in ["windows", "macos", "linux"] {
            let flags = BrowserCapabilities::for_platform(platform);
            assert!(flags.dom_snapshot && flags.element_locators, "{platform}");
            assert!(flags.navigation_control && flags.pointer_input);
            assert!(flags.independent_pointer, "{platform}");
            assert!(flags.keyboard_input && flags.select_input);
            assert_eq!(flags.screenshot, platform != "linux");
            // The frontend owns task tabs and enables this separately.
            assert!(!flags.tabs);
        }
        for platform in ["android", "ios", "unknown"] {
            let flags = BrowserCapabilities::for_platform(platform);
            assert!(!flags.dom_snapshot && !flags.element_locators);
            assert!(!flags.screenshot && !flags.pointer_input && !flags.keyboard_input);
            assert!(!flags.independent_pointer, "{platform}");
        }
    }

    #[test]
    fn result_contract_preserves_unicode_quotes_and_newlines() {
        let inner = r#"{"title":"问卷 \"保存\"","line":"第一行\n第二行"}"#;
        let raw = serde_json::json!({"value":inner}).to_string();
        let outer = decode_result(&raw).unwrap();
        assert_eq!(serde_json::from_str::<String>(&outer).unwrap(), inner);
    }

    #[test]
    fn script_errors_and_invalid_results_cannot_become_observations() {
        assert_eq!(
            decode_result(r#"{"error":"ambiguous locator"}"#).unwrap_err(),
            "ambiguous locator"
        );
        for raw in ["null", "undefined", "{}", r#"{"value":42}"#] {
            assert!(decode_result(raw).is_err(), "{raw}");
        }
        let script = wrap_script("(() => { throw new Error('missing element'); })()");
        assert!(script.contains("catch (error)"));
        assert!(script.contains("missing element"));
    }
}
