//! web_search: zero-config web search with a provider fallback chain.
//!
//! Auto mode cascades through providers until one returns results:
//! Exa MCP (keyless public endpoint) -> Bing HTML scrape -> DuckDuckGo HTML
//! scrape -> DuckDuckGo Instant Answer API. No API key or settings required.
//! Every attempt is reported in the output so the model can see which
//! providers failed and why.

mod parsers;
mod providers;

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use self::providers::{
    run_bing_search, run_duckduckgo_html_search, run_duckduckgo_instant_search, run_exa_search,
};
use crate::router::{parse_input, Tool, ToolContext, ToolError};

const DEFAULT_MAX_RESULTS: usize = 5;
const EXA_MCP_ENDPOINT: &str = "https://mcp.exa.ai/mcp";

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
    #[serde(default)]
    allowed_domains: Vec<String>,
    #[serde(default)]
    blocked_domains: Vec<String>,
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
                },
                "allowedDomains": {"type": "array", "items": {"type": "string"}, "description": "Restrict results to these domains"},
                "blockedDomains": {"type": "array", "items": {"type": "string"}, "description": "Exclude results from these domains"}
            },
            "required": ["query"]
        })
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        // Read-only queries against fixed, well-known search endpoints. Medium
        // still lets always-ask mode surface every network touch.
        Risk {
            level: RiskLevel::Medium,
            reason: "read-only web search via fixed provider endpoints".into(),
        }
    }

    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: WebSearchInput = parse_input(input)?;
        let max_results = input
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, 10);
        let provider = input.provider.unwrap_or_else(|| "auto".to_string());
        let exa_url = input
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

        let search_query =
            domain_filtered_query(&input.query, &input.allowed_domains, &input.blocked_domains)?;
        let mut attempts = Vec::new();
        let mut final_results = Vec::new();
        let mut provider_used = None;
        for name in chain {
            let outcome = match name {
                "exa" => run_exa_search(&search_query, max_results, &exa_url).await,
                "bing" => run_bing_search(&search_query, max_results).await,
                "duckduckgo" => run_duckduckgo_html_search(&search_query, max_results).await,
                "duckduckgo_instant" => {
                    run_duckduckgo_instant_search(&search_query, max_results).await
                }
                _ => unreachable!(),
            };
            match outcome {
                Ok(results) => {
                    attempts
                        .push(json!({"provider": name, "status": "ok", "count": results.len()}));
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
            "query": input.query,
            "effectiveQuery": search_query,
            "allowedDomains": input.allowed_domains,
            "blockedDomains": input.blocked_domains,
            "provider": provider_used,
            "results": final_results,
            "attempts": attempts,
        }))
    }
}

fn domain_filtered_query(
    query: &str,
    allowed_domains: &[String],
    blocked_domains: &[String],
) -> Result<String, ToolError> {
    let validate = |domain: &str| {
        !domain.is_empty()
            && domain.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '-')
            })
    };
    if let Some(domain) = allowed_domains
        .iter()
        .chain(blocked_domains)
        .find(|domain| !validate(domain))
    {
        return Err(ToolError::InvalidInput(format!(
            "invalid search domain: {domain}"
        )));
    }
    let mut filters = Vec::new();
    if !allowed_domains.is_empty() {
        filters.push(format!(
            "({})",
            allowed_domains
                .iter()
                .map(|domain| format!("site:{domain}"))
                .collect::<Vec<_>>()
                .join(" OR ")
        ));
    }
    filters.extend(
        blocked_domains
            .iter()
            .map(|domain| format!("-site:{domain}")),
    );
    Ok(std::iter::once(query.to_string())
        .chain(filters)
        .collect::<Vec<_>>()
        .join(" "))
}

#[cfg(test)]
mod tests;
