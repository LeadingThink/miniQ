use super::*;
use serde_json::json;

#[test]
fn transient_statuses_and_permanent_errors_are_distinguished() {
    for status in [408, 429, 500, 502, 503, 504, 529] {
        assert!(
            ProviderError::from_api_response(status, "temporary failure".into(), None)
                .is_retryable()
        );
    }
    for status in [400, 401, 403, 404, 422, 501] {
        assert!(
            !ProviderError::from_api_response(status, "invalid request".into(), None)
                .is_retryable()
        );
    }
    for error in [
        json!({"code":"insufficient_quota"}),
        json!({"type":"billing_not_active"}),
        json!({"message":"Your credit balance is too low"}),
    ] {
        assert!(
            !ProviderError::from_api_response(429, json!({"error":error}).to_string(), None)
                .is_retryable()
        );
    }
}

#[test]
fn stream_errors_preserve_codes_even_when_the_message_is_only_busy() {
    for error in [
        json!({"type":"overloaded_error","message":"busy"}),
        json!({"code":"server_is_overloaded"}),
        json!({"status":"UNAVAILABLE"}),
        json!({"message":"Our servers are currently overloaded. Please try again later."}),
    ] {
        assert!(ProviderError::from_stream_error("test", &error).is_retryable());
    }
    for error in [
        json!({"code":"invalid_api_key"}),
        json!({"type":"invalid_request_error","message":"invalid tools"}),
        json!({"code":"insufficient_quota","message":"overloaded"}),
    ] {
        assert!(!ProviderError::from_stream_error("test", &error).is_retryable());
    }
}

#[test]
fn retry_after_supports_delta_seconds_and_http_dates_without_shortening_long_hints() {
    let now = httpdate::parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
    assert_eq!(
        parse_retry_after("600", now),
        Some(Duration::from_secs(600))
    );
    assert_eq!(
        parse_retry_after("Wed, 21 Oct 2015 07:28:09 GMT", now),
        Some(Duration::from_secs(9))
    );
    assert_eq!(
        parse_retry_after("Wed, 21 Oct 2015 07:27:00 GMT", now),
        Some(Duration::ZERO)
    );
    for invalid in ["NaN", "-2", "invalid", ""] {
        assert_eq!(parse_retry_after(invalid, now), None);
    }
}

#[tokio::test]
async fn every_wire_protocol_preserves_http_retry_metadata() {
    use crate::{
        AnthropicProvider, ChatMessage, CompletionRequest, ModelProvider, OpenAiCompatProvider,
        ProviderConfig, ResponsesProvider,
    };
    use axum::{
        http::{header::RETRY_AFTER, StatusCode},
        routing::post,
        Json, Router,
    };
    let router = Router::new().fallback(post(|| async {
        (
            StatusCode::TOO_MANY_REQUESTS,
            [(RETRY_AFTER, "9")],
            Json(json!({"error":{"code":"rate_limit_exceeded"}})),
        )
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = ProviderConfig {
        base_url: format!("http://{}", listener.local_addr().unwrap()),
        api_key: "test-only".into(),
        model: "test".into(),
        api_protocol: Default::default(),
        reasoning_effort: None,
    };
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let providers: Vec<Box<dyn ModelProvider>> = vec![
        Box::new(OpenAiCompatProvider::new(config.clone())),
        Box::new(ResponsesProvider::new(config.clone())),
        Box::new(AnthropicProvider::new(config)),
    ];
    for provider in providers {
        let response = provider
            .stream_complete(CompletionRequest {
                messages: vec![ChatMessage::user("test")],
                tools: vec![],
                temperature: None,
                max_output_tokens: None,
            })
            .await;
        let error = match response {
            Err(error) => error,
            Ok(_) => panic!("expected a rate limit"),
        };
        assert!(error.is_retryable());
        assert_eq!(error.retry_after(), Some(Duration::from_secs(9)));
    }
    server.abort();
}
