use axum::routing::post;
use serde_json::{json, Value};

use super::parsers::{
    parse_bing_html_results, parse_duckduckgo_html_results, parse_duckduckgo_instant_results,
    parse_exa_text_results,
};
use super::*;

async fn serve(app: axum::Router) -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
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
