use super::*;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{oneshot, Semaphore};

fn cancel(queries: &mut GitQueries, id: impl Into<RequestId>) {
    assert!(queries.cancel_notification(
        &json!({"jsonrpc":"2.0","method":"request.cancel","params":{"requestId":id.into()}})
            .to_string()
    ));
}

#[test]
fn only_read_only_git_methods_can_be_cancelled() {
    for method in ["git.status", "git.diff", "git.branches"] {
        assert!(cancellable(method));
    }
    for method in [
        "session.sendMessage",
        "session.cancel",
        "file.write",
        "host.call",
    ] {
        assert!(!cancellable(method));
    }
}

#[tokio::test]
async fn cancellation_drops_query_resources_and_releases_its_dispatch_slot() {
    let mut queries = GitQueries::default();
    let slots = Arc::new(Semaphore::new(1));
    let permit = slots.clone().acquire_owned().await.unwrap();
    queries.spawn(&"query".into(), async move {
        let _permit = permit;
        std::future::pending().await
    });
    assert_eq!(slots.available_permits(), 0);
    cancel(&mut queries, "query");
    assert!(queries.join_next().await.is_none());
    assert_eq!(slots.available_permits(), 1);
    assert!(queries.active.is_empty());
    assert!(queries.keys.is_empty());
}

#[tokio::test]
async fn disconnect_drops_all_socket_owned_queries() {
    let mut queries = GitQueries::default();
    let (released, release) = oneshot::channel::<()>();
    queries.spawn(&"query".into(), async move {
        let _resource = released;
        std::future::pending().await
    });
    drop(queries);
    assert!(release.await.is_err());
}

#[tokio::test]
async fn finishing_an_old_duplicate_cannot_remove_or_reply_for_its_replacement() {
    let mut queries = GitQueries::default();
    queries.spawn(&"same".into(), std::future::pending());
    let (send, receive) = oneshot::channel();
    queries.spawn(&"same".into(), async move { receive.await.unwrap() });
    assert!(queries.join_next().await.is_none());
    assert_eq!(queries.active.len(), 1);
    send.send(RpcResponse::ok("same".into(), json!("new")))
        .unwrap();
    assert_eq!(
        queries.join_next().await.unwrap().result,
        Some(json!("new"))
    );
    assert!(queries.active.is_empty());
    assert!(queries.keys.is_empty());
}

#[tokio::test]
async fn numeric_and_string_ids_are_distinct_and_unknown_cancellation_is_harmless() {
    let mut queries = GitQueries::default();
    queries.spawn(&1.into(), std::future::pending());
    queries.spawn(&"1".into(), std::future::pending());
    cancel(&mut queries, "missing");
    cancel(&mut queries, "1");
    assert!(queries.join_next().await.is_none());
    assert_eq!(queries.active.len(), 1);
    cancel(&mut queries, 1);
    assert!(queries.join_next().await.is_none());
    assert!(queries.active.is_empty());
}

#[tokio::test]
async fn completed_and_panicked_queries_release_bookkeeping() {
    let mut queries = GitQueries::default();
    queries.spawn(&"done".into(), async {
        RpcResponse::ok("done".into(), json!(true))
    });
    assert!(queries.join_next().await.is_some());
    queries.spawn(&"panic".into(), async { panic!("handler failed") });
    assert!(queries.join_next().await.is_none());
    assert!(queries.active.is_empty());
    assert!(queries.keys.is_empty());
}
