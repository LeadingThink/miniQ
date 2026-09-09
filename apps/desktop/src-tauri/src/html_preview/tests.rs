use super::*;
use axum::body::to_bytes;
use axum::http::Request;
use tower::ServiceExt;

fn grant(root: &Path) -> Grant {
    Grant {
        id: "test-capability".into(),
        root: root.canonicalize().unwrap(),
        origin: "http://127.0.0.1:19999".into(),
        network: false,
        cancelled: CancellationToken::new(),
    }
}

fn request(path: &str) -> axum::http::request::Builder {
    Request::builder()
        .uri(path)
        .header(header::HOST, "127.0.0.1:19999")
}

#[tokio::test]
async fn serves_complete_relative_resources_with_an_opaque_sandbox_and_ranges() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("assets")).unwrap();
    std::fs::write(root.path().join("assets/data.json"), "{\"value\":12345}").unwrap();
    let app = router(grant(root.path()));
    let response = app
        .clone()
        .oneshot(
            request("/test-capability/assets/data.json?v=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "null"
    );
    let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap();
    assert!(csp.starts_with("sandbox allow-scripts;"));
    assert!(!csp.contains("allow-same-origin"));
    assert!(!csp.contains(" https:"));
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        b"{\"value\":12345}"
    );
    let response = app
        .clone()
        .oneshot(
            request("/test-capability/assets/data.json")
                .header(header::RANGE, "bytes=9-11")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 9-11/15");
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        b"123"
    );
    let response = app
        .clone()
        .oneshot(
            request("/test-capability/assets/data.json")
                .method(Method::HEAD)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "15");
    assert!(to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .is_empty());
    let response = app
        .oneshot(
            request("/test-capability/assets/data.json")
                .header(header::RANGE, "bytes=100-200")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */15");
}

#[tokio::test]
async fn rejects_mutation_missing_capabilities_traversal_secrets_and_revoked_grants() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("index.html"), "<h1>preview</h1>").unwrap();
    std::fs::write(root.path().join(".env"), "secret").unwrap();
    let grant = grant(root.path());
    let app = router(grant.clone());
    for path in [
        "/wrong/index.html",
        "/test-capability/../index.html",
        "/test-capability/%2e%2e/index.html",
        "/test-capability/.env",
        "/test-capability/",
    ] {
        let response = app
            .clone()
            .oneshot(request(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(response.status().is_client_error(), "{path}");
    }
    let response = app
        .clone()
        .oneshot(
            request("/test-capability/index.html")
                .method(Method::POST)
                .body(Body::from("overwrite"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/test-capability/index.html")
                .header(header::HOST, "attacker.example:19999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    grant.cancelled.cancel();
    let response = app
        .oneshot(
            request("/test-capability/index.html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        std::fs::read_to_string(root.path().join("index.html")).unwrap(),
        "<h1>preview</h1>"
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_outside_the_document_directory() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.json"), "secret").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.json"),
        root.path().join("data.json"),
    )
    .unwrap();
    assert_eq!(
        resource_path(&grant(root.path()), "test-capability", "data.json").unwrap_err(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn network_access_is_explicit_and_never_adds_app_permissions() {
    let root = tempfile::tempdir().unwrap();
    let mut grant = grant(root.path());
    assert!(!policy(&grant).contains(" https:"));
    grant.network = true;
    assert!(policy(&grant).contains(" https: http:"));
    assert!(!policy(&grant).contains("ipc:"));
    assert!(!policy(&grant).contains("allow-same-origin"));
}

#[tokio::test]
async fn large_media_is_streamed_and_revocation_stops_inflight_bodies() {
    let root = tempfile::tempdir().unwrap();
    let file = std::fs::File::create(root.path().join("large.mp4")).unwrap();
    file.set_len(128 * 1024 * 1024).unwrap();
    let grant = grant(root.path());
    let response = router(grant.clone())
        .oneshot(
            request("/test-capability/large.mp4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "134217728");
    let mut stream = response.into_body().into_data_stream();
    let first = stream.next().await.unwrap().unwrap();
    assert!(first.len() <= 65536);
    grant.cancelled.cancel();
    assert!(stream.next().await.is_none());
}
