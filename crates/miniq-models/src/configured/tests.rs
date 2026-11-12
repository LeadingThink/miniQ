use super::*;
use axum::{routing::get, Json, Router};
use serde_json::json;

#[test]
fn infers_native_protocols_for_well_known_model_families() {
    assert_eq!(
        infer_protocol("claude-sonnet-4.6"),
        ApiProtocol::AnthropicMessages
    );
    assert_eq!(infer_protocol("gpt-5.6-sol"), ApiProtocol::Responses);
    assert_eq!(infer_protocol("o4-mini"), ApiProtocol::Responses);
    assert_eq!(
        infer_protocol("gemini-3.1-pro"),
        ApiProtocol::ChatCompletions
    );
}

#[test]
fn grok_context_window_is_capped_to_the_observed_gateway_input_limit() {
    let payload = json!({"data": {"max_tokens": 500_000}});
    let capabilities = cap_model_context("grok-4.7", extract_capabilities(&payload));
    assert_eq!(capabilities.max_context_tokens, Some(220_000));
}

#[test]
fn model_metadata_overrides_name_inference() {
    let payload = json!({"data":{"preferred_api_protocol":"chat_completions"}});
    assert_eq!(
        extract_protocol(&payload),
        Some(ApiProtocol::ChatCompletions)
    );
}

#[test]
fn extracts_oneapi_model_limits() {
    let payload = json!({
        "data": {
            "preferred_api_protocol": "responses",
            "supported_api_protocols": ["responses", "chat_completions"],
            "max_tokens": 1_000_000,
            "max_output": "128000"
        }
    });

    assert_eq!(
        extract_capabilities(&payload),
        ModelCapabilities {
            preferred_api_protocol: Some(ApiProtocol::Responses),
            supported_api_protocols: Some(vec![
                ApiProtocol::Responses,
                ApiProtocol::ChatCompletions,
            ]),
            max_output_tokens: Some(128_000),
            max_context_tokens: Some(1_000_000),
            reasoning_efforts: None,
        }
    );
}

#[tokio::test]
async fn auto_protocol_reads_provider_metadata() {
    let app = Router::new().route(
        "/v1/models/{model}",
        get(|headers: axum::http::HeaderMap| async move {
            let authenticated = headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                == Some("Bearer metadata-secret");
            Json(json!({
                "data": {
                    "preferred_api_protocol": if authenticated { "anthropic_messages" } else { "chat_completions" },
                    "max_tokens": 1_000_000,
                    "max_output": 128_000
                }
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let provider = ConfiguredProvider::new(ProviderConfig {
        base_url: format!("http://{address}/v1"),
        api_key: "metadata-secret".into(),
        model: "custom-model".into(),
        api_protocol: ApiProtocol::Auto,
        reasoning_effort: None,
    });

    assert_eq!(
        provider.protocol().await.unwrap(),
        ApiProtocol::AnthropicMessages
    );
    assert_eq!(
        provider.capabilities().await,
        ModelCapabilities {
            preferred_api_protocol: Some(ApiProtocol::AnthropicMessages),
            supported_api_protocols: None,
            max_output_tokens: Some(128_000),
            max_context_tokens: Some(1_000_000),
            reasoning_efforts: None,
        }
    );
    assert_eq!(
        provider
            .execution_info(None)
            .await
            .unwrap()
            .unwrap()
            .max_output_tokens,
        Some(128_000)
    );
}

/// The gateway in the report answered `/models/{model}` with an empty body
/// and published `supported_reasoning_efforts` only in the paginated
/// catalog. Namespaced IDs also break the single-segment detail route.
#[tokio::test]
async fn catalog_details_supply_reasoning_efforts_for_namespaced_models() {
    use crate::provider::ReasoningEffort;

    let app = Router::new()
        .route(
            "/v1/models/details",
            get(|| async {
                Json(json!({
                    "code": "0",
                    "msg": "ok",
                    "data": {
                        "models": [
                            {
                                "model_id": "hy/deepseek-v4.1-flash-1017",
                                "max_tokens": 300_144,
                                "max_output": 128_000,
                                "supported_reasoning_efforts": ["none", "low", "high", "max"]
                            },
                            {"model_id": "unrelated-model"}
                        ],
                        "total": 2
                    }
                }))
            }),
        )
        .route(
            "/v1/models/{model}",
            get(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    Json(json!({"error": "not found"})),
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let provider = ConfiguredProvider::new(ProviderConfig {
        base_url: format!("http://{address}/v1"),
        api_key: "catalog-secret".into(),
        model: "hy/deepseek-v4.1-flash-1017".into(),
        api_protocol: ApiProtocol::Auto,
        reasoning_effort: None,
    });

    let capabilities = provider.capabilities().await;
    assert_eq!(
        capabilities.reasoning_efforts,
        Some(vec![
            ReasoningEffort::None,
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max,
        ])
    );
    assert_eq!(capabilities.max_context_tokens, Some(300_144));
    assert_eq!(capabilities.max_output_tokens, Some(128_000));
}
