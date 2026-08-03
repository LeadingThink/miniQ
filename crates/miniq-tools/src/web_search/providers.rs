use std::time::Duration;

use serde_json::{json, Value};

use super::parsers::{
    parse_bing_html_results, parse_duckduckgo_html_results, parse_duckduckgo_instant_results,
    parse_exa_text_results,
};

const SEARCH_TIMEOUT_SECS: u64 = 18;
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE: &str = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|error| error.to_string())
}

async fn fetch_html(url: url::Url) -> Result<String, String> {
    let response = http_client()?
        .get(url)
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .header(reqwest::header::ACCEPT_LANGUAGE, ACCEPT_LANGUAGE)
        .header(reqwest::header::ACCEPT, "text/html,*/*;q=0.1")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response.text().await.map_err(|error| error.to_string())
}

/// Query the public Exa MCP endpoint (JSON-RPC `tools/call` -> `web_search_exa`).
/// The endpoint answers as SSE (`data: {...}` lines) or plain JSON.
pub(super) async fn run_exa_search(
    query: &str,
    max_results: usize,
    exa_url: &str,
) -> Result<Vec<Value>, String> {
    let endpoint =
        url::Url::parse(exa_url).map_err(|error| format!("invalid exa endpoint: {error}"))?;
    let response = http_client()?
        .post(endpoint)
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
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
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Exa MCP returned {}", response.status().as_u16()));
    }
    let body = response.text().await.map_err(|error| error.to_string())?;
    let chunks = extract_exa_content(&body);
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

fn extract_exa_content(body: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut saw_sse = false;
    for line in body.lines() {
        let Some(payload) = line.strip_prefix("data: ") else {
            continue;
        };
        if payload.trim().is_empty() || payload.trim() == "[DONE]" {
            continue;
        }
        saw_sse = true;
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            collect_content(&value, &mut chunks);
        }
    }
    if !saw_sse {
        if let Ok(value) = serde_json::from_str::<Value>(body) {
            collect_content(&value, &mut chunks);
        }
    }
    chunks
}

fn collect_content(value: &Value, chunks: &mut Vec<String>) {
    let Some(items) = value.pointer("/result/content").and_then(Value::as_array) else {
        return;
    };
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                chunks.push(text.to_string());
            }
        }
    }
}

pub(super) async fn run_bing_search(query: &str, max_results: usize) -> Result<Vec<Value>, String> {
    let url = url::Url::parse_with_params(
        "https://www.bing.com/search",
        &[("q", query), ("setlang", "zh-CN"), ("cc", "CN")],
    )
    .map_err(|error| error.to_string())?;
    let html = fetch_html(url).await?;
    Ok(parse_bing_html_results(&html, max_results))
}

pub(super) async fn run_duckduckgo_html_search(
    query: &str,
    max_results: usize,
) -> Result<Vec<Value>, String> {
    let url = url::Url::parse_with_params(
        "https://duckduckgo.com/html/",
        &[("q", query), ("kl", "cn-zh")],
    )
    .map_err(|error| error.to_string())?;
    let html = fetch_html(url).await?;
    Ok(parse_duckduckgo_html_results(&html, max_results))
}

pub(super) async fn run_duckduckgo_instant_search(
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
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(parse_duckduckgo_instant_results(&payload, max_results))
}
