use miniq_models::mock::MockProvider;
use miniq_models::ChatDelta;
use serde_json::json;

use crate::support::{call, connect, next_event_of, setup_session, start, tool_call};

#[tokio::test]
async fn web_fetch_needs_domain_approval_then_session_grant_covers_same_domain() {
    // Local HTTP server the agent will fetch from.
    let app = axum::Router::new()
        .route("/a", axum::routing::get(|| async { "page A" }))
        .route("/b", axum::routing::get(|| async { "page B" }));
    let http = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let http_port = http.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(http, app).await.unwrap() });

    let provider = MockProvider::new(vec![
        vec![tool_call(
            "c1",
            "web_fetch",
            json!({"url": format!("http://127.0.0.1:{http_port}/a")}),
        )],
        vec![tool_call(
            "c2",
            "web_fetch",
            json!({"url": format!("http://127.0.0.1:{http_port}/b")}),
        )],
        vec![ChatDelta::Text("fetched both".into())],
    ]);
    let (port, token) = start(provider).await;
    let mut ws = connect(port, &token).await;

    let dir = tempfile::tempdir().unwrap();
    let session_id = setup_session(&mut ws, dir.path()).await;

    call(
        &mut ws,
        "r1",
        "session.sendMessage",
        json!({"sessionId": session_id, "message": {"role": "user", "content": "fetch pages"}}),
    )
    .await;

    // First fetch: high risk (network) -> approval with the domain visible.
    let requested = next_event_of(&mut ws, "approval_requested").await;
    assert_eq!(requested["toolName"], "web_fetch");
    assert_eq!(requested["riskLevel"], "high");
    assert!(requested["approval"]["reason"]
        .as_str()
        .unwrap()
        .contains("127.0.0.1"));
    let approval_id = requested["approval"]["id"].as_str().unwrap().to_string();
    call(
        &mut ws,
        "r2",
        "approval.resolve",
        json!({"approvalId": approval_id, "decision": "approve_for_session"}),
    )
    .await;

    // Both fetches succeed; the second (same domain) required no approval.
    let first = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(first["status"], "succeeded");
    assert!(first["output"]["content"]
        .as_str()
        .unwrap()
        .contains("page A"));
    let second = next_event_of(&mut ws, "tool_call_finished").await;
    assert_eq!(second["status"], "succeeded");
    assert!(second["output"]["content"]
        .as_str()
        .unwrap()
        .contains("page B"));
    next_event_of(&mut ws, "turn_completed").await;
}
