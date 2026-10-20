use super::*;

use axum::{extract::State, http::StatusCode, routing::post, Router};
use std::future::IntoFuture;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
#[test]
fn custom_provider_credentials_are_not_forwarded() {
    for base in [
        "https://example.com/v1",
        "http://oneapi.zaiwenai.com/v1",
        "https://oneapi.zaiwenai.com.evil.test/v1",
        "https://user@oneapi.zaiwenai.com/v1",
    ] {
        assert!(provider_media_uploader(base, "fixture-key", CancellationToken::new()).is_none());
    }
    assert!(provider_media_uploader(
        "https://oneapi.zaiwenai.com/v1",
        "fixture-key",
        CancellationToken::new()
    )
    .is_some());
}
#[test]
fn signed_storage_redirect_targets_are_restricted() {
    for bad in [
        "https://evil.test/file",
        "https://127.0.0.1/file",
        "http://s3-cn-south-1.qiniucs.com/file",
        "https://qiniucs.com.evil.test/file",
    ] {
        assert!(storage_url(bad).is_err());
    }
    assert!(storage_url(
        "https://s3-cn-south-1.qiniucs.com/bucket/provider-media/fixture?signature=fixture"
    )
    .is_ok());
}

#[tokio::test]
async fn transient_ticket_failures_are_retried_three_times() {
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = Router::new()
        .route(
            "/ticket",
            post(|State(calls): State<Arc<AtomicUsize>>| async move {
                calls.fetch_add(1, Ordering::SeqCst);
                StatusCode::SERVICE_UNAVAILABLE
            }),
        )
        .with_state(calls.clone());
    let handle = tokio::spawn(axum::serve(listener, server).into_future());
    let uploader = HttpUploader {
        key: "fixture-key".into(),
        cancel: CancellationToken::new(),
        endpoint: format!("http://{address}/ticket"),
    };

    let error = uploader
        .upload(vec![1, 2, 3], "image/png")
        .await
        .unwrap_err();
    assert!(error.contains("HTTP 503"));
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    handle.abort();
}

#[tokio::test]
async fn permanent_ticket_failures_are_not_retried() {
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = Router::new()
        .route(
            "/ticket",
            post(|State(calls): State<Arc<AtomicUsize>>| async move {
                calls.fetch_add(1, Ordering::SeqCst);
                StatusCode::UNAUTHORIZED
            }),
        )
        .with_state(calls.clone());
    let handle = tokio::spawn(axum::serve(listener, server).into_future());
    let uploader = HttpUploader {
        key: "fixture-key".into(),
        cancel: CancellationToken::new(),
        endpoint: format!("http://{address}/ticket"),
    };

    let error = uploader.upload(vec![1], "image/png").await.unwrap_err();
    assert!(error.contains("HTTP 401"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    handle.abort();
}
