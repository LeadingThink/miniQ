//! Visible browser automation backed by Chrome DevTools Protocol.
//!
//! The browser runs in a separate, temporary Chrome profile. Mutating actions
//! are high risk and therefore pass through the daemon's existing approval and
//! audit path before reaching this tool.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use headless_chrome::{Browser, LaunchOptions};
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_PAGE_SIZE: usize = 500;

struct BrowserSession {
    _browser: Browser,
    tab: Arc<headless_chrome::Tab>,
}

#[derive(Clone, Default)]
pub struct BrowserAutomationTool {
    session: Arc<Mutex<Option<BrowserSession>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserInput {
    action: String,
    url: Option<String>,
    target: Option<String>,
    text: Option<String>,
    key: Option<String>,
    clear: Option<bool>,
    submit: Option<bool>,
    delta_y: Option<i64>,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn parse_web_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|error| format!("invalid URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("browser only allows HTTP(S) URLs".into());
    }
    Ok(url)
}

fn status(tab: &headless_chrome::Tab) -> Result<Value, String> {
    Ok(json!({
        "url": tab.get_url(),
        "title": tab.get_title().map_err(|error| error.to_string())?,
    }))
}

fn target_selector(target: &str) -> String {
    if target.starts_with("rpa-") {
        format!("[data-miniq-rpa-id=\"{target}\"]")
    } else {
        target.to_string()
    }
}

fn snapshot(tab: &headless_chrome::Tab, offset: usize, limit: usize) -> Result<Value, String> {
    let script = format!(
        r#"(() => {{
          const visible = (node) => {{
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          }};
          const nodes = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"]')].filter(visible);
          const total = nodes.length;
          const items = nodes.slice({offset}, {end}).map((node, index) => {{
            let id = node.getAttribute('data-miniq-rpa-id');
            if (!id) {{ id = `rpa-${{Date.now().toString(36)}}-${{{offset} + index}}`; node.setAttribute('data-miniq-rpa-id', id); }}
            return {{
              target: id,
              tag: node.tagName.toLowerCase(),
              role: node.getAttribute('role'),
              text: (node.innerText || node.value || '').trim(),
              label: node.getAttribute('aria-label') || node.getAttribute('title'),
              placeholder: node.getAttribute('placeholder'),
              type: node.getAttribute('type'),
              href: node.href || null,
              disabled: Boolean(node.disabled)
            }};
          }});
          return JSON.stringify({{ title: document.title, url: location.href, total, offset: {offset}, limit: {limit}, items }});
        }})()"#,
        end = offset.saturating_add(limit),
    );
    let remote = tab
        .evaluate(&script, false)
        .map_err(|error| error.to_string())?;
    let encoded = remote
        .value
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| "browser snapshot returned no data".to_string())?;
    serde_json::from_str(&encoded).map_err(|error| error.to_string())
}

fn open_browser(session: &mut Option<BrowserSession>, url: &str) -> Result<Value, String> {
    let url = parse_web_url(url)?;
    if let Some(active) = session.as_ref() {
        active
            .tab
            .navigate_to(url.as_str())
            .map_err(|error| error.to_string())?
            .wait_until_navigated()
            .map_err(|error| error.to_string())?;
        return status(&active.tab);
    }

    let options = LaunchOptions::default_builder()
        .headless(false)
        .window_size(Some((1280, 820)))
        .idle_browser_timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?;
    let browser = Browser::new(options).map_err(|error| error.to_string())?;
    let tab = browser.new_tab().map_err(|error| error.to_string())?;
    tab.navigate_to(url.as_str())
        .map_err(|error| error.to_string())?
        .wait_until_navigated()
        .map_err(|error| error.to_string())?;
    let result = status(&tab)?;
    *session = Some(BrowserSession {
        _browser: browser,
        tab,
    });
    Ok(result)
}

fn with_tab<T>(
    session: &mut Option<BrowserSession>,
    operation: impl FnOnce(&headless_chrome::Tab) -> Result<T, String>,
) -> Result<T, String> {
    let active = session
        .as_ref()
        .ok_or_else(|| "browser is not open; call action=open first".to_string())?;
    operation(&active.tab)
}

fn execute_browser(
    session: &mut Option<BrowserSession>,
    input: BrowserInput,
) -> Result<Value, String> {
    match input.action.as_str() {
        "open" | "navigate" => {
            open_browser(session, input.url.as_deref().ok_or("url is required")?)
        }
        "snapshot" => with_tab(session, |tab| {
            snapshot(
                tab,
                input.offset.unwrap_or(0),
                input
                    .limit
                    .unwrap_or(DEFAULT_PAGE_SIZE)
                    .clamp(1, MAX_PAGE_SIZE),
            )
        }),
        "status" => with_tab(session, status),
        "click" => with_tab(session, |tab| {
            let selector = target_selector(input.target.as_deref().ok_or("target is required")?);
            tab.wait_for_element(&selector)
                .map_err(|error| error.to_string())?
                .click()
                .map_err(|error| error.to_string())?;
            std::thread::sleep(Duration::from_millis(350));
            status(tab)
        }),
        "type" => with_tab(session, |tab| {
            let selector = target_selector(input.target.as_deref().ok_or("target is required")?);
            let element = tab
                .wait_for_element(&selector)
                .map_err(|error| error.to_string())?;
            element.click().map_err(|error| error.to_string())?;
            if input.clear.unwrap_or(true) {
                element
                    .call_js_fn("function() { this.value = ''; }", vec![], false)
                    .map_err(|error| error.to_string())?;
            }
            element
                .type_into(input.text.as_deref().ok_or("text is required")?)
                .map_err(|error| error.to_string())?;
            if input.submit.unwrap_or(false) {
                tab.press_key("Enter").map_err(|error| error.to_string())?;
            }
            status(tab)
        }),
        "press" => with_tab(session, |tab| {
            tab.press_key(input.key.as_deref().ok_or("key is required")?)
                .map_err(|error| error.to_string())?;
            status(tab)
        }),
        "scroll" => with_tab(session, |tab| {
            let delta = input.delta_y.unwrap_or(640);
            tab.evaluate(&format!("window.scrollBy(0, {delta})"), false)
                .map_err(|error| error.to_string())?;
            status(tab)
        }),
        "close" => {
            *session = None;
            Ok(json!({"closed": true}))
        }
        action => Err(format!("unknown browser action: {action}")),
    }
}

#[async_trait]
impl Tool for BrowserAutomationTool {
    fn name(&self) -> &str {
        "browser_automation"
    }

    fn description(&self) -> &str {
        "Control a visible, isolated Chrome session for browser RPA. Open a page, inspect paged interactive elements, click, type, press keys, scroll, check status, or close. Use snapshot targets instead of guessing selectors."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["open", "navigate", "snapshot", "status", "click", "type", "press", "scroll", "close"]},
                "url": {"type": "string", "description": "HTTP(S) URL for open or navigate"},
                "target": {"type": "string", "description": "Target id returned by snapshot, or a CSS selector"},
                "text": {"type": "string", "description": "Text for the type action"},
                "key": {"type": "string", "description": "Chrome key name for press"},
                "clear": {"type": "boolean", "default": true},
                "submit": {"type": "boolean", "default": false},
                "deltaY": {"type": "integer", "default": 640},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100}
            },
            "required": ["action"]
        })
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        let action = input.get("action").and_then(Value::as_str).unwrap_or("");
        let level = match action {
            "snapshot" | "status" | "close" => RiskLevel::Low,
            _ => RiskLevel::High,
        };
        Risk {
            level,
            reason: format!("visible browser automation action: {action}"),
        }
    }

    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: BrowserInput = parse_input(input)?;
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = session
                .lock()
                .map_err(|_| "browser session lock poisoned".to_string())?;
            execute_browser(&mut guard, input)
        })
        .await
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
        .map_err(ToolError::ExecutionFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{response::Html, routing::get, Router};

    #[test]
    fn url_policy_allows_only_web_pages() {
        assert!(parse_web_url("https://example.com").is_ok());
        assert!(parse_web_url("http://127.0.0.1:3000").is_ok());
        assert!(parse_web_url("file:///etc/passwd").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn snapshot_is_read_only_but_interaction_requires_approval() {
        let tool = BrowserAutomationTool::default();
        let context = ToolContext::new(std::env::temp_dir());
        assert_eq!(
            tool.evaluate_risk(&context, &json!({"action": "snapshot"}))
                .level,
            RiskLevel::Low
        );
        assert_eq!(
            tool.evaluate_risk(&context, &json!({"action": "click", "target": "rpa-1"}))
                .level,
            RiskLevel::High
        );
    }

    #[tokio::test]
    #[ignore = "requires a locally installed Chrome or Chromium"]
    async fn visible_browser_roundtrip() {
        let app = Router::new().route(
            "/",
            get(|| async {
                Html(
                    r#"<!doctype html><button id="run" onclick="this.textContent='完成'">执行</button>"#,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let tool = BrowserAutomationTool::default();
        let context = ToolContext::new(std::env::temp_dir());
        tool.execute(
            &context,
            json!({"action": "open", "url": format!("http://{address}/")}),
        )
        .await
        .unwrap();
        let page = tool
            .execute(&context, json!({"action": "snapshot"}))
            .await
            .unwrap();
        assert_eq!(page["items"][0]["text"], "执行");
        let target = page["items"][0]["target"].as_str().unwrap();
        tool.execute(&context, json!({"action": "click", "target": target}))
            .await
            .unwrap();
        let page = tool
            .execute(&context, json!({"action": "snapshot"}))
            .await
            .unwrap();
        assert_eq!(page["items"][0]["text"], "完成");
        tool.execute(&context, json!({"action": "close"}))
            .await
            .unwrap();
    }
}
