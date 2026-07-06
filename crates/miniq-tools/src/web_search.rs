//! web_search: zero-config web search with a provider fallback chain.
//!
//! Auto mode cascades through providers until one returns results:
//! Exa MCP (keyless public endpoint) → Bing HTML scrape → DuckDuckGo HTML
//! scrape → DuckDuckGo Instant Answer API. No API key or settings required.
//! Every attempt is reported in the output so the model can see which
//! providers failed and why.

use std::collections::HashSet;
use std::time::Duration;

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

const SEARCH_TIMEOUT_SECS: u64 = 18;
const DEFAULT_MAX_RESULTS: usize = 5;
const EXA_MCP_ENDPOINT: &str = "https://mcp.exa.ai/mcp";
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE: &str = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";

/// Search provider configuration, kept for settings compatibility.
/// web_search no longer consumes it — the free fallback chain needs no key.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    /// Currently supported: "tavily".
    pub provider: String,
    pub api_key: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

// ---- HTML helpers (regex-based, no extra dependencies) ----

fn decode_basic_html_entities(value: &str) -> String {
    let mut decoded = value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    if let Ok(decimal_re) = Regex::new(r"&#(\d+);") {
        decoded = decimal_re
            .replace_all(&decoded, |caps: &regex::Captures| {
                caps.get(1)
                    .and_then(|v| v.as_str().parse::<u32>().ok())
                    .and_then(char::from_u32)
                    .unwrap_or(' ')
                    .to_string()
            })
            .to_string();
    }
    if let Ok(hex_re) = Regex::new(r"&#x([0-9a-fA-F]+);") {
        decoded = hex_re
            .replace_all(&decoded, |caps: &regex::Captures| {
                caps.get(1)
                    .and_then(|v| u32::from_str_radix(v.as_str(), 16).ok())
                    .and_then(char::from_u32)
                    .unwrap_or(' ')
                    .to_string()
            })
            .to_string();
    }
    decoded
}

/// Strip tags and squash whitespace in an HTML fragment.
fn clean_html_fragment(fragment: &str) -> String {
    let stripped = Regex::new(r"(?is)<[^>]+>")
        .ok()
        .map(|re| re.replace_all(fragment, " ").to_string())
        .unwrap_or_else(|| fragment.to_string());
    decode_basic_html_entities(&stripped)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// DuckDuckGo wraps result links as `//duckduckgo.com/l/?uddg=<real-url>`.
fn unwrap_duckduckgo_redirect(raw_url: &str) -> String {
    let normalized = if raw_url.starts_with("//") {
        format!("https:{raw_url}")
    } else {
        raw_url.to_string()
    };
    if let Ok(parsed) = url::Url::parse(&normalized) {
        if parsed.host_str() == Some("duckduckgo.com") && parsed.path() == "/l/" {
            if let Some((_, value)) = parsed.query_pairs().find(|(key, _)| key == "uddg") {
                return value.into_owned();
            }
        }
    }
    normalized
}

/// Push a `{title, url, snippet}` entry, skipping empties/dupes/non-http URLs.
fn push_result(
    results: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    title: &str,
    url: &str,
    snippet: &str,
    max_results: usize,
) {
    if results.len() >= max_results {
        return;
    }
    let title = title.trim();
    let url = url.trim();
    if title.is_empty() || url.is_empty() {
        return;
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return;
    }
    if !seen.insert(url.to_string()) {
        return;
    }
    results.push(json!({
        "title": title,
        "url": url,
        "snippet": snippet.trim(),
    }));
}

// ---- Result parsers, one per provider ----

/// Exa MCP returns results as text blocks: `Title: ...\nURL: ...\nText: ...`.
/// Parsed line by line — a `Title:` line starts a new block.
fn parse_exa_text_results(raw_text: &str, max_results: usize) -> Vec<Value> {
    let text = raw_text.replace("\r\n", "\n");
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    for line in text.lines() {
        if line.starts_with("Title:") {
            blocks.push(vec![line]);
        } else if let Some(current) = blocks.last_mut() {
            current.push(line);
        }
    }

    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for block in blocks {
        let mut title = String::new();
        let mut url = String::new();
        let mut snippet_parts: Vec<String> = Vec::new();
        let mut in_text = false;
        for line in block {
            if let Some(v) = line.strip_prefix("Title:") {
                title = v.trim().to_string();
                in_text = false;
            } else if let Some(v) = line.strip_prefix("URL:") {
                url = v.trim().to_string();
                in_text = false;
            } else if let Some(v) = line
                .strip_prefix("Text:")
                .or_else(|| line.strip_prefix("Highlights:"))
            {
                if !v.trim().is_empty() {
                    snippet_parts.push(v.trim().to_string());
                }
                in_text = true;
            } else if line.starts_with("Author:") || line.starts_with("Published") {
                in_text = false;
            } else if in_text && line.trim() != "..." {
                snippet_parts.push(line.trim().to_string());
            }
        }
        let snippet: String = clean_html_fragment(&snippet_parts.join(" "))
            .chars()
            .take(500)
            .collect();
        push_result(
            &mut results,
            &mut seen,
            &clean_html_fragment(&title),
            &url,
            &snippet,
            max_results,
        );
        if results.len() >= max_results {
            break;
        }
    }
    results
}

fn parse_bing_html_results(html: &str, max_results: usize) -> Vec<Value> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let (Ok(item_re), Ok(link_re), Ok(snippet_re)) = (
        Regex::new(r#"(?is)<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>(.*?)</li>"#),
        Regex::new(r#"(?is)<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#),
        Regex::new(r#"(?is)<p[^>]*>(.*?)</p>"#),
    ) else {
        return results;
    };
    for item in item_re.captures_iter(html) {
        let block = item.get(1).map(|v| v.as_str()).unwrap_or_default();
        let Some(link) = link_re.captures(block) else { continue };
        let url = decode_basic_html_entities(link.get(1).map(|v| v.as_str()).unwrap_or_default());
        let title = clean_html_fragment(link.get(2).map(|v| v.as_str()).unwrap_or_default());
        let snippet = snippet_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|v| clean_html_fragment(v.as_str()))
            .unwrap_or_default();
        push_result(&mut results, &mut seen, &title, &url, &snippet, max_results);
        if results.len() >= max_results {
            break;
        }
    }
    results
}

fn parse_duckduckgo_html_results(html: &str, max_results: usize) -> Vec<Value> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let (Ok(item_re), Ok(link_re), Ok(snippet_re)) = (
        Regex::new(r#"(?is)<div[^>]*class="[^"]*\bresult__body\b[^"]*"[^>]*>(.*?)</div>"#),
        Regex::new(r#"(?is)<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#),
        Regex::new(r#"(?is)<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)</a>"#),
    ) else {
        return results;
    };
    for item in item_re.captures_iter(html) {
        let block = item.get(1).map(|v| v.as_str()).unwrap_or_default();
        let Some(link) = link_re.captures(block) else { continue };
        let url = unwrap_duckduckgo_redirect(&decode_basic_html_entities(
            link.get(1).map(|v| v.as_str()).unwrap_or_default(),
        ));
        let title = clean_html_fragment(link.get(2).map(|v| v.as_str()).unwrap_or_default());
        let snippet = snippet_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|v| clean_html_fragment(v.as_str()))
            .unwrap_or_default();
        push_result(&mut results, &mut seen, &title, &url, &snippet, max_results);
        if results.len() >= max_results {
            break;
        }
    }
    results
}

fn parse_duckduckgo_instant_results(payload: &Value, max_results: usize) -> Vec<Value> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    if let Some(abstract_text) = payload.get("AbstractText").and_then(Value::as_str) {
        let url = payload
            .get("AbstractURL")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let heading = payload
            .get("Heading")
            .and_then(Value::as_str)
            .unwrap_or("Result");
        push_result(&mut results, &mut seen, heading, url, abstract_text, max_results);
    }
    let push_topic = |item: &Value, results: &mut Vec<Value>, seen: &mut HashSet<String>| {
        let text = item.get("Text").and_then(Value::as_str).unwrap_or_default();
        let link = item
            .get("FirstURL")
            .and_then(Value::as_str)
            .unwrap_or_default();
        push_result(results, seen, text, link, text, max_results);
    };
    if let Some(related) = payload.get("RelatedTopics").and_then(Value::as_array) {
        for item in related {
            if item.get("Text").is_some() {
                push_topic(item, &mut results, &mut seen);
            } else if let Some(topics) = item.get("Topics").and_then(Value::as_array) {
                for topic in topics {
                    push_topic(topic, &mut results, &mut seen);
                    if results.len() >= max_results {
                        break;
                    }
                }
            }
            if results.len() >= max_results {
                break;
            }
        }
    }
    results
}

// ---- Provider runners ----

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_html(url: url::Url) -> Result<String, String> {
    let response = http_client()?
        .get(url)
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .header(reqwest::header::ACCEPT_LANGUAGE, ACCEPT_LANGUAGE)
        .header(reqwest::header::ACCEPT, "text/html,*/*;q=0.1")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response.text().await.map_err(|e| e.to_string())
}

/// Query the public Exa MCP endpoint (JSON-RPC `tools/call` → `web_search_exa`).
/// The endpoint answers as SSE (`data: {...}` lines) or plain JSON; both are handled.
async fn run_exa_search(
    query: &str,
    max_results: usize,
    exa_url: &str,
) -> Result<Vec<Value>, String> {
    let endpoint =
        url::Url::parse(exa_url).map_err(|e| format!("invalid exa endpoint: {e}"))?;
    let response = http_client()?
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "web_search_exa",
                "arguments": {
                    "query": query,
                    "numResults": max_results as u64,
                    "livecrawl": "fallback",
                    "type": "auto",
                    "contextMaxCharacters": 12000,
                }
            }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Exa MCP returned {}", response.status().as_u16()));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;

    let mut chunks = Vec::new();
    let mut collect_content = |value: &Value| {
        if let Some(items) = value.pointer("/result/content").and_then(Value::as_array) {
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        if !text.trim().is_empty() {
                            chunks.push(text.to_string());
                        }
                    }
                }
            }
        }
    };
    let mut saw_sse = false;
    for line in body.lines() {
        let Some(payload) = line.strip_prefix("data: ") else { continue };
        if payload.trim().is_empty() || payload.trim() == "[DONE]" {
            continue;
        }
        saw_sse = true;
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            collect_content(&value);
        }
    }
    if !saw_sse {
        if let Ok(value) = serde_json::from_str::<Value>(&body) {
            collect_content(&value);
        }
    }

    let merged = chunks.join("\n");
    let mut parsed = parse_exa_text_results(&merged, max_results);
    if parsed.is_empty() && !merged.trim().is_empty() {
        parsed.push(json!({
            "title": format!("Exa search summary: {query}"),
            "url": "https://mcp.exa.ai/",
            "snippet": merged.chars().take(500).collect::<String>(),
        }));
    }
    Ok(parsed)
}

async fn run_bing_search(query: &str, max_results: usize) -> Result<Vec<Value>, String> {
    let url = url::Url::parse_with_params(
        "https://www.bing.com/search",
        &[("q", query), ("setlang", "zh-CN"), ("cc", "CN")],
    )
    .map_err(|e| e.to_string())?;
    let html = fetch_html(url).await?;
    Ok(parse_bing_html_results(&html, max_results))
}

async fn run_duckduckgo_html_search(
    query: &str,
    max_results: usize,
) -> Result<Vec<Value>, String> {
    let url = url::Url::parse_with_params(
        "https://duckduckgo.com/html/",
        &[("q", query), ("kl", "cn-zh")],
    )
    .map_err(|e| e.to_string())?;
    let html = fetch_html(url).await?;
    Ok(parse_duckduckgo_html_results(&html, max_results))
}

async fn run_duckduckgo_instant_search(
    query: &str,
    max_results: usize,
) -> Result<Vec<Value>, String> {
    let payload = http_client()?
        .get("https://api.duckduckgo.com/")
        .query(&[
            ("q", query),
            ("format", "json"),
            ("no_redirect", "1"),
            ("no_html", "1"),
            ("skip_disambig", "1"),
        ])
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_duckduckgo_instant_results(&payload, max_results))
}

// ---- The tool ----

pub struct WebSearchTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchInput {
    query: String,
    #[serde(default)]
    max_results: Option<usize>,
    /// "auto" (default) | "exa" | "bing" | "duckduckgo".
    #[serde(default)]
    provider: Option<String>,
    /// Override the Exa MCP endpoint (tests / self-hosted relays).
    #[serde(default)]
    exa_url: Option<String>,
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    fn description(&self) -> &str {
        "Search the web and return result titles, URLs and snippets. Works without \
         any configuration: falls back through Exa, Bing and DuckDuckGo until one \
         provider returns results."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "maxResults": {"type": "integer", "description": "Max results (1-10, default 5)"},
                "provider": {
                    "type": "string",
                    "enum": ["auto", "exa", "bing", "duckduckgo"],
                    "description": "Force a specific provider; default auto (fallback chain)"
                }
            },
            "required": ["query"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        // Read-only queries against fixed, well-known search endpoints — the
        // model never controls which hosts are contacted (unlike web_fetch,
        // which is High). Medium: runs unprompted in auto mode, but
        // always-ask mode still surfaces every network touch.
        Risk {
            level: RiskLevel::Medium,
            reason: "read-only web search via fixed provider endpoints".into(),
        }
    }
    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: WebSearchInput = parse_input(input)?;
        let max_results = p.max_results.unwrap_or(DEFAULT_MAX_RESULTS).clamp(1, 10);
        let provider = p.provider.unwrap_or_else(|| "auto".to_string());
        let exa_url = p
            .exa_url
            .unwrap_or_else(|| EXA_MCP_ENDPOINT.to_string());

        let chain: Vec<&str> = match provider.as_str() {
            "auto" => vec!["exa", "bing", "duckduckgo", "duckduckgo_instant"],
            "exa" => vec!["exa"],
            "bing" => vec!["bing"],
            "duckduckgo" => vec!["duckduckgo", "duckduckgo_instant"],
            other => {
                return Err(ToolError::InvalidInput(format!(
                    "provider must be one of auto|exa|bing|duckduckgo, got {other}"
                )))
            }
        };

        let mut attempts = Vec::new();
        let mut final_results = Vec::new();
        let mut provider_used = None;
        for name in chain {
            let outcome = match name {
                "exa" => run_exa_search(&p.query, max_results, &exa_url).await,
                "bing" => run_bing_search(&p.query, max_results).await,
                "duckduckgo" => run_duckduckgo_html_search(&p.query, max_results).await,
                "duckduckgo_instant" => {
                    run_duckduckgo_instant_search(&p.query, max_results).await
                }
                _ => unreachable!(),
            };
            match outcome {
                Ok(results) => {
                    attempts.push(json!({"provider": name, "status": "ok", "count": results.len()}));
                    if !results.is_empty() {
                        provider_used = Some(name.to_string());
                        final_results = results;
                        break;
                    }
                }
                Err(error) => {
                    attempts.push(json!({"provider": name, "status": "error", "error": error}));
                }
            }
        }

        Ok(json!({
            "query": p.query,
            "provider": provider_used,
            "results": final_results,
            "attempts": attempts,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::post;

    async fn serve(app: axum::Router) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        port
    }

    fn ctx() -> ToolContext {
        ToolContext::new(std::path::PathBuf::from("."))
    }

    #[test]
    fn parses_bing_html() {
        let html = r#"<ol><li class="b_algo"><h2><a href="https://example.com/a?x=1&amp;y=2">Rust <b>lang</b></a></h2><p>A systems &quot;language&quot;.</p></li></ol>"#;
        let results = parse_bing_html_results(html, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["url"], "https://example.com/a?x=1&y=2");
        assert_eq!(results[0]["title"], "Rust lang");
        assert_eq!(results[0]["snippet"], "A systems \"language\".");
    }

    #[test]
    fn parses_duckduckgo_html_and_unwraps_redirect() {
        let html = r#"<div class="result__body"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&amp;rut=x">Rust</a><a class="result__snippet">Fast and safe.</a></div>"#;
        let results = parse_duckduckgo_html_results(html, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["url"], "https://rust-lang.org/");
        assert_eq!(results[0]["snippet"], "Fast and safe.");
    }

    #[test]
    fn parses_duckduckgo_instant_payload() {
        let payload = json!({
            "Heading": "Rust",
            "AbstractText": "A systems language.",
            "AbstractURL": "https://rust-lang.org",
            "RelatedTopics": [
                {"Text": "Cargo", "FirstURL": "https://doc.rust-lang.org/cargo/"},
                {"Topics": [{"Text": "Tokio", "FirstURL": "https://tokio.rs"}]}
            ]
        });
        let results = parse_duckduckgo_instant_results(&payload, 5);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0]["url"], "https://rust-lang.org");
        assert_eq!(results[2]["url"], "https://tokio.rs");
    }

    #[test]
    fn parses_exa_text_blocks() {
        let text = "Title: Rust\nAuthor: someone\nURL: https://rust-lang.org\nText: Systems language.\nTitle: Tokio\nURL: https://tokio.rs\nText: Async runtime.";
        let results = parse_exa_text_results(text, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["url"], "https://rust-lang.org");
        assert_eq!(results[1]["title"], "Tokio");
    }

    #[tokio::test]
    async fn exa_mcp_contract_sse() {
        let app = axum::Router::new().route(
            "/mcp",
            post(|body: axum::Json<Value>| async move {
                assert_eq!(body["method"], "tools/call");
                assert_eq!(body["params"]["name"], "web_search_exa");
                let event = json!({
                    "result": {"content": [{"type": "text",
                        "text": "Title: Rust\nURL: https://rust-lang.org\nText: Systems language."}]}
                });
                format!("event: message\ndata: {event}\n\n")
            }),
        );
        let port = serve(app).await;
        let out = WebSearchTool
            .execute(
                &ctx(),
                json!({
                    "query": "rust",
                    "provider": "exa",
                    "exaUrl": format!("http://127.0.0.1:{port}/mcp"),
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["provider"], "exa");
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["url"], "https://rust-lang.org");
    }

    #[test]
    fn parses_exa_highlights_format() {
        // The live mcp.exa.ai response uses Published:/Highlights: labels.
        let text = "Title: Rust Programming Language\nURL: https://rust-lang.org/\nPublished: N/A\nAuthor: N/A\nHighlights:\nRust is fast.\n...\nRust is safe.";
        let results = parse_exa_text_results(text, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["url"], "https://rust-lang.org/");
        assert_eq!(results[0]["snippet"], "Rust is fast. Rust is safe.");
    }

    #[tokio::test]
    #[ignore = "hits the real network; run with: cargo test -p miniq-tools -- --ignored"]
    async fn real_network_auto_search() {
        let out = WebSearchTool
            .execute(&ctx(), json!({"query": "Rust 编程语言", "maxResults": 3}))
            .await
            .unwrap();
        let results = out["results"].as_array().unwrap();
        assert!(
            !results.is_empty(),
            "auto chain returned nothing: {}",
            out["attempts"]
        );
    }

    #[tokio::test]
    async fn rejects_unknown_provider() {
        let err = WebSearchTool
            .execute(&ctx(), json!({"query": "hello", "provider": "google"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("provider must be one of"));
    }
}
