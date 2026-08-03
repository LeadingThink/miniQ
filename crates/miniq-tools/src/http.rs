//! http_request: generic HTTP API calls. High risk (network), approved per
//! domain by the executor.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};
use crate::web::url_host;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const TIMEOUT_SECS: u64 = 30;

pub struct HttpRequestTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpRequestInput {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: Option<std::collections::BTreeMap<String, String>>,
    /// Raw request body (JSON string or plain text).
    #[serde(default)]
    body: Option<String>,
}

#[async_trait]
impl Tool for HttpRequestTool {
    fn name(&self) -> &str {
        "http_request"
    }
    fn description(&self) -> &str {
        "Make an HTTP request to an API endpoint (GET/POST/PUT/PATCH/DELETE). \
         Returns status, headers and body. Requires approval per domain."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "Default GET"},
                "headers": {"type": "object", "additionalProperties": {"type": "string"}},
                "body": {"type": "string", "description": "Raw request body"}
            },
            "required": ["url"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, input: &Value) -> Risk {
        match url_host(input) {
            Some(host) => Risk {
                level: RiskLevel::High,
                reason: format!("network request to {host}"),
            },
            None => Risk {
                level: RiskLevel::Blocked,
                reason: "missing or invalid url".into(),
            },
        }
    }
    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: HttpRequestInput = parse_input(input)?;
        let parsed = url::Url::parse(&p.url)
            .map_err(|e| ToolError::InvalidInput(format!("bad url: {e}")))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(ToolError::InvalidInput(format!(
                "unsupported scheme: {}",
                parsed.scheme()
            )));
        }
        let method = p.method.unwrap_or_else(|| "GET".to_string()).to_uppercase();
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| ToolError::InvalidInput(format!("bad method: {method}")))?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
            .build()
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        let mut req = client.request(method, parsed);
        if let Some(headers) = p.headers {
            for (key, value) in headers {
                req = req.header(key, value);
            }
        }
        if let Some(body) = p.body {
            req = req.body(body);
        }
        let response = req
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("request failed: {e}")))?;

        let status = response.status().as_u16();
        let headers: serde_json::Map<String, Value> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or("<non-utf8>"))))
            .collect();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        let truncated = bytes.len() > MAX_RESPONSE_BYTES;
        let body =
            String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_RESPONSE_BYTES)]).to_string();

        Ok(json!({
            "url": p.url,
            "status": status,
            "headers": headers,
            "body": body,
            "truncated": truncated,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::post;

    #[tokio::test]
    async fn post_json_roundtrip() {
        let app = axum::Router::new().route(
            "/api",
            post(|body: String| async move {
                assert_eq!(body, r#"{"ping":true}"#);
                axum::Json(json!({"pong": true}))
            }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let ctx = ToolContext::new(std::path::PathBuf::from("."));
        let out = HttpRequestTool
            .execute(
                &ctx,
                json!({
                    "url": format!("http://127.0.0.1:{port}/api"),
                    "method": "POST",
                    "headers": {"content-type": "application/json"},
                    "body": r#"{"ping":true}"#
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["status"], 200);
        assert!(out["body"].as_str().unwrap().contains("pong"));
    }

    #[test]
    fn risk_is_domain_scoped_high() {
        let ctx = ToolContext::new(std::path::PathBuf::from("."));
        let risk =
            HttpRequestTool.evaluate_risk(&ctx, &json!({"url": "https://api.example.com/v1"}));
        assert_eq!(risk.level, RiskLevel::High);
        assert!(risk.reason.contains("api.example.com"));
    }
}
