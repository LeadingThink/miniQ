use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    http::StatusCode,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use futures_util::TryStreamExt;
use serde_json::json;

use crate::{
    ApiProtocol, ChatDelta, ChatMessage, CompletionRequest, ConfiguredProvider, ModelProvider,
    ProviderConfig,
};

#[tokio::test]
async fn auto_protocol_falls_back_from_oneapi_route_404_and_caches_successful_route() {
    let paths = Arc::new(Mutex::new(Vec::new()));
    let response_paths = paths.clone();
    let chat_paths = paths.clone();
    let app = Router::new()
        .route(
            "/v1/models/{model}",
            get(|| async {
                Json(json!({
                    "data": {
                        "preferred_api_protocol": "responses",
                        "supported_api_protocols": ["responses", "chat_completions"]
                    }
                }))
            }),
        )
        .route(
            "/v1/responses",
            post(move || {
                let paths = response_paths.clone();
                async move {
                    paths.lock().unwrap().push("/v1/responses");
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": {
                                "message": "openai_error",
                                "type": "bad_response_status_code",
                                "param": "",
                                "code": "bad_response_status_code"
                            }
                        })),
                    )
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move || {
                let paths = chat_paths.clone();
                async move {
                    paths.lock().unwrap().push("/v1/chat/completions");
                    let body = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                    Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let provider = ConfiguredProvider::new(ProviderConfig {
        base_url: format!("http://{address}/v1"),
        api_key: "test-key".into(),
        model: "grok-4.5".into(),
        api_protocol: ApiProtocol::Auto,
        reasoning_effort: None,
    });
    let large_context = "previous task context ".repeat(4_000);
    let request = || CompletionRequest {
        trace: Default::default(),
        messages: vec![ChatMessage::user(large_context.clone())],
        tools: Vec::new(),
        temperature: None,
        max_output_tokens: Some(128),
    };

    for _ in 0..2 {
        let deltas = provider
            .stream_complete(request())
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert!(deltas.contains(&ChatDelta::Text("ok".into())));
        assert!(deltas.contains(&ChatDelta::Finished));
    }
    assert_eq!(
        provider
            .execution_info(Some(128))
            .await
            .unwrap()
            .unwrap()
            .api_protocol,
        ApiProtocol::ChatCompletions
    );
    assert_eq!(
        paths.lock().unwrap().as_slice(),
        [
            "/v1/responses",
            "/v1/chat/completions",
            "/v1/chat/completions"
        ]
    );
}

#[tokio::test]
async fn explicit_protocol_does_not_fallback_on_oneapi_route_404() {
    let paths = Arc::new(Mutex::new(Vec::new()));
    let response_paths = paths.clone();
    let app = Router::new().route(
        "/v1/responses",
        post(move || {
            let paths = response_paths.clone();
            async move {
                paths.lock().unwrap().push("/v1/responses");
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({
                        "error": {"message": "openai_error", "type": "bad_response_status_code"}
                    })),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let provider = ConfiguredProvider::new(ProviderConfig {
        base_url: format!("http://{address}/v1"),
        api_key: "test-key".into(),
        model: "grok-4.5".into(),
        api_protocol: ApiProtocol::Responses,
        reasoning_effort: None,
    });
    let error = match provider
        .stream_complete(CompletionRequest {
            trace: Default::default(),
            messages: vec![ChatMessage::user("hello")],
            tools: Vec::new(),
            temperature: None,
            max_output_tokens: Some(128),
        })
        .await
    {
        Ok(_) => panic!("explicit Responses protocol unexpectedly fell back"),
        Err(error) => error,
    };
    assert!(error.is_protocol_route_not_found());
    assert_eq!(paths.lock().unwrap().as_slice(), ["/v1/responses"]);
}
