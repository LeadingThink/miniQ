use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::provider::{indicates_context_window_overflow, ProviderError};

impl ProviderError {
    pub(crate) async fn from_http_response(response: reqwest::Response) -> Self {
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| parse_retry_after(value, SystemTime::now()));
        match response.text().await {
            Ok(body) => Self::from_api_response(status, body, retry_after),
            Err(error) => Self::Api {
                status,
                body: format!("could not read provider error response: {error}"),
                retry_after,
            },
        }
    }

    pub(crate) fn from_api_response(
        status: u16,
        body: String,
        retry_after: Option<Duration>,
    ) -> Self {
        if indicates_context_window_overflow(&body) {
            Self::ContextWindowExceeded
        } else {
            Self::Api {
                status,
                body,
                retry_after,
            }
        }
    }

    pub(crate) fn from_stream_error(prefix: &str, error: &Value) -> Self {
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string());
        let message = format!("{prefix}: {detail}");
        if indicates_context_window_overflow(&error.to_string()) {
            Self::ContextWindowExceeded
        } else if !requires_user_action(error) && is_transient_error(error) {
            Self::Transient(message)
        } else {
            Self::InvalidResponse(message)
        }
    }

    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http(error) => error.is_timeout() || error.is_connect() || error.is_body(),
            Self::Api { status, body, .. } => {
                let error = serde_json::from_str::<Value>(body)
                    .unwrap_or_else(|_| Value::String(body.clone()));
                !requires_user_action(error.get("error").unwrap_or(&error))
                    && matches!(status, 408 | 429 | 500 | 502 | 503 | 504 | 529)
            }
            Self::Transient(_)
            | Self::EmptyResponse
            | Self::IncompleteStream
            | Self::OutputLimitReached(_)
            | Self::IncompleteToolArguments { .. } => true,
            Self::InvalidResponse(_) | Self::ContextWindowExceeded | Self::Config(_) => false,
        }
    }

    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Api { retry_after, .. } => *retry_after,
            _ => None,
        }
    }
}

fn parse_retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    httpdate::parse_http_date(value)
        .ok()
        .map(|date| date.duration_since(now).unwrap_or_default())
}

fn requires_user_action(error: &Value) -> bool {
    let detail = error.to_string().to_ascii_lowercase();
    [
        "insufficient_quota",
        "billing_not_active",
        "credit_balance_too_low",
        "usage_limit_reached",
        "insufficient quota",
        "exceeded your current quota",
        "credit balance",
        "billing hard limit",
        "authentication_error",
        "invalid_api_key",
        "permission_error",
    ]
    .iter()
    .any(|value| detail.contains(value))
}

fn is_transient_error(error: &Value) -> bool {
    let transient_code = ["code", "type", "status"]
        .iter()
        .filter_map(|field| error.get(field)?.as_str())
        .any(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "overloaded_error"
                    | "server_is_overloaded"
                    | "rate_limit_error"
                    | "rate_limit_exceeded"
                    | "slow_down"
                    | "server_error"
                    | "internal_server_error"
                    | "resource_exhausted"
                    | "unavailable"
                    | "deadline_exceeded"
            )
        });
    let detail = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    transient_code || detail.contains("overloaded") || detail.contains("temporarily unavailable")
}

#[cfg(test)]
mod tests;
