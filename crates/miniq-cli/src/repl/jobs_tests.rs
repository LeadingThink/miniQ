use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn slow_mutations_keep_reads_responsive_and_preserve_mutation_order() {
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    miniq_local::write_connection_info(
        directory.path(),
        &miniq_local::ConnectionInfo::current(
            listener.local_addr().unwrap().port(),
            "fixture".into(),
        )
        .unwrap(),
    )
    .unwrap();
    let (observed, mut received) = tokio::sync::mpsc::unbounded_channel();
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let release_server = release.clone();
    let server = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let observed = observed.clone();
            let release = release_server.clone();
            tasks.spawn(async move {
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(data))) = socket.next().await {
                    let request: Value = serde_json::from_str(&data).unwrap();
                    let method = request["method"].as_str().unwrap();
                    let result = if method == "daemon.health" {
                        json!({"protocolVersion":miniq_protocol::PROTOCOL_VERSION,"capabilities":{"rejectBusy":true}})
                    } else {
                        let name = request["params"]["name"].as_str().unwrap().to_owned();
                        observed.send(name.clone()).unwrap();
                        if name == "first" { release.notified().await; }
                        json!({"name":name})
                    };
                    if socket.send(Message::text(json!({"id":request["id"],"result":result}).to_string())).await.is_err() { break; }
                }
            });
        }
    });
    let mut jobs = Jobs::default();
    for (name, method) in [
        ("first", "session.rename"),
        ("second", "session.rename"),
        ("read", "session.contextUsage"),
    ] {
        jobs.push(
            "s",
            name,
            Effect::Notice(name.into()),
            Request::Rpc {
                method: method.into(),
                params: json!({"name":name}),
            },
        );
    }
    jobs.start(directory.path(), None);
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), jobs.next())
        .await
        .unwrap();
    assert_eq!(first.result.unwrap()["name"], "read");
    let mut before = vec![
        received.recv().await.unwrap(),
        received.recv().await.unwrap(),
    ];
    before.sort();
    assert_eq!(before, vec!["first", "read"]);
    assert!(received.try_recv().is_err());
    release.notify_one();
    assert_eq!(jobs.next().await.result.unwrap()["name"], "first");
    assert_eq!(jobs.next().await.result.unwrap()["name"], "second");
    server.abort();
}
