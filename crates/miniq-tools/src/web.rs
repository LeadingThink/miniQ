//! web_fetch and web_search: network tools. Both are high risk (network
//! access) and go through per-domain approval in the executor.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

const FETCH_DEFAULT_MAX_BYTES: usize = 2 * 1024 * 1024;
const FETCH_TIMEOUT_SECS: u64 = 30;

fn network_risk(reason: String) -> Risk {
    Risk {
        level: RiskLevel::High,
        reason,
    }
}

/// Extract the host from a URL input field for risk display and approval
/// pattern scoping.
pub fn url_host(input: &Value) -> Option<String> {
    let raw = input.get("url")?.as_str()?;
    let parsed = url::Url::parse(raw).ok()?;
    parsed.host_str().map(|h| h.to_string())
}

fn validate_url(raw: &str) -> Result<url::Url, ToolError> {
    let parsed =
        url::Url::parse(raw).map_err(|e| ToolError::InvalidInput(format!("bad url: {e}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ToolError::InvalidInput(format!(
            "unsupported scheme: {}",
            parsed.scheme()
        )));
    }
    Ok(parsed)
}

// ---- web_fetch ----

pub struct WebFetchTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebFetchInput {
    url: String,
    #[serde(default)]
    max_bytes: Option<usize>,
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }
    fn description(&self) -> &str {
        "Fetch a web page and return its readable text content (HTML is converted to \
         plain text). Requires approval per domain."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "http(s) URL to fetch"},
                "maxBytes": {"type": "integer", "description": "Response size cap in bytes (default 2MB)"}
            },
            "required": ["url"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        match url_host(input) {
            Some(host) => network_risk(format!("network access to {host}")),
            None => Risk {
                level: RiskLevel::Blocked,
                reason: "missing or invalid url".into(),
            },
        }
    }
    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: WebFetchInput = parse_input(input)?;
        let parsed = validate_url(&p.url)?;
        let max_bytes = p.max_bytes.unwrap_or(FETCH_DEFAULT_MAX_BYTES);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
            .user_agent("miniQ/0.1 (+local desktop agent)")
            .build()
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        let response = client
            .get(parsed)
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("fetch failed: {e}")))?;

        let status = response.status().as_u16();
        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Stream the body with a hard size cap.
        let mut body: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
            if body.len() + chunk.len() > max_bytes {
                body.extend_from_slice(&chunk[..max_bytes - body.len()]);
                truncated = true;
                break;
            }
            body.extend_from_slice(&chunk);
        }

        let text = String::from_utf8_lossy(&body).to_string();
        let content = if content_type.contains("text/html") {
            html2text::from_read(text.as_bytes(), 100)
        } else if content_type.contains("text/")
            || content_type.contains("json")
            || content_type.contains("xml")
            || content_type.is_empty()
        {
            text
        } else {
            return Err(ToolError::ExecutionFailed(format!(
                "unsupported content type: {content_type}"
            )));
        };

        Ok(json!({
            "url": p.url,
            "finalUrl": final_url,
            "status": status,
            "contentType": content_type,
            "content": content,
            "truncated": truncated,
        }))
    }
}

// ---- web_search ----

/// Search provider configuration, supplied by the daemon via ToolContext.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    /// Currently supported: "tavily".
    pub provider: String,
    pub api_key: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

pub struct WebSearchTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchInput {
    query: String,
    #[serde(default)]
    max_results: Option<usize>,
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    fn description(&self) -> &str {
        "Search the web and return result titles, URLs and snippets. Requires a \
         configured search provider."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "maxResults": {"type": "integer", "description": "Default 5, max 10"}
            },
            "required": ["query"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        network_risk("network access to the configured search provider".into())
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: WebSearchInput = parse_input(input)?;
        let Some(config) = &ctx.search else {
            return Err(ToolError::ExecutionFailed(
                "web_search is not configured; ask the user to set a search provider \
                 (settings: search.provider + search.apiKey)"
                    .into(),
            ));
        };
        if config.provider != "tavily" {
            return Err(ToolError::ExecutionFailed(format!(
                "unsupported search provider: {}",
                config.provider
            )));
        }
        let max_results = p.max_results.unwrap_or(5).clamp(1, 10);
        let base = config
            .base_url
            .clone()
            .unwrap_or_else(|| "https://api.tavily.com".to_string());
        let url = format!("{}/search", base.trim_end_matches('/'));

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
            .build()
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        let response = client
            .post(&url)
            .json(&json!({
                "api_key": config.api_key,
                "query": p.query,
                "max_results": max_results,
            }))
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("search failed: {e}")))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            return Err(ToolError::ExecutionFailed(format!(
                "search provider returned {status}"
            )));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        let results: Vec<Value> = body["results"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|r| {
                        json!({
                            "title": r["title"],
                            "url": r["url"],
                            "snippet": r["content"],
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(json!({ "query": p.query, "results": results }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};

    async fn serve(app: axum::Router) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        port
    }

    fn ctx() -> ToolContext {
        ToolContext::new(std::path::PathBuf::from("."))
    }

    #[tokio::test]
    async fn fetch_html_to_text() {
        let app = axum::Router::new().route(
            "/page",
            get(|| async {
                axum::response::Html(
                    "<html><head><script>evil()</script></head>\
                     <body><h1>Title</h1><p>Hello <b>world</b></p></body></html>",
                )
            }),
        );
        let port = serve(app).await;
        let out = WebFetchTool
            .execute(&ctx(), json!({"url": format!("http://127.0.0.1:{port}/page")}))
            .await
            .unwrap();
        assert_eq!(out["status"], 200);
        let content = out["content"].as_str().unwrap();
        assert!(content.contains("Title"));
        assert!(content.contains("Hello"));
        assert!(!content.contains("evil"), "script content must be stripped");
    }

    #[tokio::test]
    async fn fetch_size_cap() {
        let app = axum::Router::new().route(
            "/big",
            get(|| async { "x".repeat(10_000) }),
        );
        let port = serve(app).await;
        let out = WebFetchTool
            .execute(
                &ctx(),
                json!({"url": format!("http://127.0.0.1:{port}/big"), "maxBytes": 1000}),
            )
            .await
            .unwrap();
        assert_eq!(out["truncated"], true);
        assert_eq!(out["content"].as_str().unwrap().len(), 1000);
    }

    #[tokio::test]
    async fn fetch_rejects_bad_scheme_and_reports_domain_risk() {
        let err = WebFetchTool
            .execute(&ctx(), json!({"url": "file:///etc/passwd"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unsupported scheme"));

        let risk = WebFetchTool.evaluate_risk(&ctx(), &json!({"url": "https://example.com/x"}));
        assert_eq!(risk.level, RiskLevel::High);
        assert!(risk.reason.contains("example.com"));
    }

    #[tokio::test]
    async fn search_unconfigured_errors() {
        let err = WebSearchTool
            .execute(&ctx(), json!({"query": "hello"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not configured"));
    }

    #[tokio::test]
    async fn search_tavily_contract() {
        let app = axum::Router::new().route(
            "/search",
            post(|body: axum::Json<Value>| async move {
                assert_eq!(body["query"], "rust");
                axum::Json(json!({
                    "results": [
                        {"title": "Rust", "url": "https://rust-lang.org", "content": "systems language"}
                    ]
                }))
            }),
        );
        let port = serve(app).await;
        let mut context = ctx();
        context.search = Some(SearchConfig {
            provider: "tavily".into(),
            api_key: "k".into(),
            base_url: Some(format!("http://127.0.0.1:{port}")),
        });
        let out = WebSearchTool
            .execute(&context, json!({"query": "rust"}))
            .await
            .unwrap();
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["url"], "https://rust-lang.org");
        assert_eq!(results[0]["snippet"], "systems language");
    }
}
