use std::collections::HashSet;

use regex::Regex;
use serde_json::{json, Value};

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
                    .and_then(|value| value.as_str().parse::<u32>().ok())
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
                    .and_then(|value| u32::from_str_radix(value.as_str(), 16).ok())
                    .and_then(char::from_u32)
                    .unwrap_or(' ')
                    .to_string()
            })
            .to_string();
    }
    decoded
}

fn clean_html_fragment(fragment: &str) -> String {
    let stripped = Regex::new(r"(?is)<[^>]+>")
        .ok()
        .map(|regex| regex.replace_all(fragment, " ").to_string())
        .unwrap_or_else(|| fragment.to_string());
    decode_basic_html_entities(&stripped)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

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

pub(super) fn parse_exa_text_results(raw_text: &str, max_results: usize) -> Vec<Value> {
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
        let mut snippet_parts = Vec::new();
        let mut in_text = false;
        for line in block {
            if let Some(value) = line.strip_prefix("Title:") {
                title = value.trim().to_string();
                in_text = false;
            } else if let Some(value) = line.strip_prefix("URL:") {
                url = value.trim().to_string();
                in_text = false;
            } else if let Some(value) = line
                .strip_prefix("Text:")
                .or_else(|| line.strip_prefix("Highlights:"))
            {
                if !value.trim().is_empty() {
                    snippet_parts.push(value.trim().to_string());
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

pub(super) fn parse_bing_html_results(html: &str, max_results: usize) -> Vec<Value> {
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
        let block = item.get(1).map(|value| value.as_str()).unwrap_or_default();
        let Some(link) = link_re.captures(block) else {
            continue;
        };
        let url =
            decode_basic_html_entities(link.get(1).map(|value| value.as_str()).unwrap_or_default());
        let title =
            clean_html_fragment(link.get(2).map(|value| value.as_str()).unwrap_or_default());
        let snippet = snippet_re
            .captures(block)
            .and_then(|capture| capture.get(1))
            .map(|value| clean_html_fragment(value.as_str()))
            .unwrap_or_default();
        push_result(&mut results, &mut seen, &title, &url, &snippet, max_results);
        if results.len() >= max_results {
            break;
        }
    }
    results
}

pub(super) fn parse_duckduckgo_html_results(html: &str, max_results: usize) -> Vec<Value> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let (Ok(item_re), Ok(link_re), Ok(snippet_re)) = (
        Regex::new(r#"(?is)<div[^>]*class="[^"]*\bresult__body\b[^"]*"[^>]*>(.*?)</div>"#),
        Regex::new(
            r#"(?is)<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#,
        ),
        Regex::new(r#"(?is)<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)</a>"#),
    ) else {
        return results;
    };
    for item in item_re.captures_iter(html) {
        let block = item.get(1).map(|value| value.as_str()).unwrap_or_default();
        let Some(link) = link_re.captures(block) else {
            continue;
        };
        let url = unwrap_duckduckgo_redirect(&decode_basic_html_entities(
            link.get(1).map(|value| value.as_str()).unwrap_or_default(),
        ));
        let title =
            clean_html_fragment(link.get(2).map(|value| value.as_str()).unwrap_or_default());
        let snippet = snippet_re
            .captures(block)
            .and_then(|capture| capture.get(1))
            .map(|value| clean_html_fragment(value.as_str()))
            .unwrap_or_default();
        push_result(&mut results, &mut seen, &title, &url, &snippet, max_results);
        if results.len() >= max_results {
            break;
        }
    }
    results
}

pub(super) fn parse_duckduckgo_instant_results(payload: &Value, max_results: usize) -> Vec<Value> {
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
        push_result(
            &mut results,
            &mut seen,
            heading,
            url,
            abstract_text,
            max_results,
        );
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
