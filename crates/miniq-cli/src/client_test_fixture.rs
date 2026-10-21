use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::Client;

pub enum Reply {
    Result(Value),
    Error(i64, &'static str),
    Disconnect,
}

pub struct Fixture {
    pub client: Client,
    requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
}

impl Fixture {
    pub async fn new(steps: Vec<(&'static str, Reply)>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        miniq_local::write_connection_info(
            directory.path(),
            &miniq_local::ConnectionInfo {
                port: listener.local_addr().unwrap().port(),
                token: "fixture-token".into(),
                pid: 0,
            },
        )
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let health: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(health["method"], "daemon.health");
            socket
                .send(Message::text(
                    json!({"id":health["id"],"result":{
                        "protocolVersion":miniq_protocol::PROTOCOL_VERSION,
                        "daemonVersion":env!("CARGO_PKG_VERSION"),
                        "capabilities":{"rejectBusy":true,"idleShutdown":true}
                    }})
                    .to_string(),
                ))
                .await
                .unwrap();
            for (method, reply) in steps {
                let request: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(request["method"], method);
                recorded.lock().unwrap().push(request.clone());
                let response = match reply {
                    Reply::Result(result) => json!({"id":request["id"],"result":result}),
                    Reply::Error(code, message) => {
                        json!({"id":request["id"],"error":{"code":code,"message":message,"data":{"fixture":true}}})
                    }
                    Reply::Disconnect => {
                        socket.close(None).await.unwrap();
                        return;
                    }
                };
                socket
                    .send(Message::text(response.to_string()))
                    .await
                    .unwrap();
            }
        });
        let client = Client::connect(directory.path()).await.unwrap();
        Self {
            client,
            requests,
            server,
            _directory: directory,
        }
    }

    pub async fn finish(self) -> Vec<Value> {
        drop(self.client);
        self.server.await.unwrap();
        Arc::try_unwrap(self.requests)
            .unwrap()
            .into_inner()
            .unwrap()
    }
}
