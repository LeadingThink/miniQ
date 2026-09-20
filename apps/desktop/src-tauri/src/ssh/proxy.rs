//! Private loopback WebSocket adapter for one SSH JSONL connection.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{routing::get, Router};
use futures_util::{SinkExt, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use super::process::{Bridge, MAX_FRAME_BYTES};

pub struct Proxy {
    pub port: u16,
    pub token: String,
    pub alive: Arc<AtomicBool>,
    pub cancel: CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct Transport {
    token: String,
    cancel: CancellationToken,
    input: mpsc::Sender<String>,
    output: broadcast::Sender<Arc<str>>,
    socket_attached: Arc<AtomicBool>,
}

impl Proxy {
    pub async fn start(bridge: Bridge) -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "无法创建本地 SSH 连接端口")?;
        let port = listener
            .local_addr()
            .map_err(|_| "无法读取本地 SSH 端口")?
            .port();
        let token = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let alive = Arc::new(AtomicBool::new(true));
        let (input, requests) = mpsc::channel(16);
        let (output, _) = broadcast::channel(16);
        let transport = Transport {
            token: token.clone(),
            cancel: cancel.clone(),
            input,
            output: output.clone(),
            socket_attached: Arc::new(AtomicBool::new(false)),
        };
        let app = Router::new()
            .route("/ws", get(upgrade))
            .with_state(transport);
        let stopped = cancel.clone();
        let active = alive.clone();
        let task = tokio::spawn(async move {
            let shutdown = stopped.clone();
            // Keep listener ownership in this task so stop() only returns after
            // the listener is dropped; aborting a detached task is not a join.
            let server = async move {
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(shutdown.cancelled_owned())
                    .await;
            };
            tokio::select! {
                _ = run_bridge(bridge, requests, output, stopped.clone()) => {}
                _ = server => {}
            }
            active.store(false, Ordering::SeqCst);
            stopped.cancel();
        });
        Ok(Self {
            port,
            token,
            alive,
            cancel,
            task,
        })
    }

    pub async fn stop(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

#[derive(serde::Deserialize)]
struct Credentials {
    token: String,
}

async fn upgrade(
    State(transport): State<Transport>,
    Query(credentials): Query<Credentials>,
    ws: WebSocketUpgrade,
) -> Response {
    if transport.cancel.is_cancelled() || credentials.token != transport.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if transport.socket_attached.swap(true, Ordering::SeqCst) {
        return StatusCode::CONFLICT.into_response();
    }
    // The guard also resets the slot when HTTP upgrade fails before on_upgrade runs.
    let guard = SocketGuard(transport.socket_attached.clone());
    let output = transport.output.subscribe();
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| serve_socket(socket, transport, output, guard))
        .into_response()
}

struct SocketGuard(Arc<AtomicBool>);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn serve_socket(
    socket: WebSocket,
    transport: Transport,
    mut output: broadcast::Receiver<Arc<str>>,
    _guard: SocketGuard,
) {
    let (mut sink, mut stream) = socket.split();
    let namespace = format!("{}:", uuid::Uuid::new_v4());
    loop {
        tokio::select! {
            _ = transport.cancel.cancelled() => break,
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Some(line) = prepare_request(&text, &namespace) else { break };
                    tokio::select! {
                        _ = transport.cancel.cancelled() => break,
                        result = transport.input.send(line) => if result.is_err() { break; },
                    }
                }
                Some(Ok(Message::Ping(bytes))) => { if sink.send(Message::Pong(bytes)).await.is_err() { break; } }
                Some(Ok(Message::Pong(_))) => {}
                _ => break,
            },
            outgoing = output.recv() => {
                // A lagged consumer reconnects and refreshes its snapshot; never silently
                // lose an RPC response or let an unbounded queue exhaust the desktop.
                let Ok(text) = outgoing else { break };
                let Some(text) = route_response(&text, &namespace) else { continue };
                tokio::select! {
                    _ = transport.cancel.cancelled() => break,
                    result = sink.send(Message::Text(text.into())) => if result.is_err() { break; },
                }
            }
        }
    }
}

fn prepare_request(text: &str, namespace: &str) -> Option<String> {
    let mut request: miniq_protocol::RpcRequest = serde_json::from_str(text).ok()?;
    if request.jsonrpc != "2.0" {
        return None;
    }
    let original = serde_json::to_string(&request.id).ok()?;
    request.id = format!("{namespace}{original}").into();
    let line = serde_json::to_string(&request).ok()?;
    (line.len() <= MAX_FRAME_BYTES).then_some(line)
}

fn route_response(text: &str, namespace: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(text).ok()?;
    if let Some(id) = value.get("id") {
        // A newly attached UI starts its request counter again. Responses from
        // its predecessor must never resolve a different request with that ID.
        let original = id.as_str()?.strip_prefix(namespace)?;
        let id: miniq_protocol::RequestId = serde_json::from_str(original).ok()?;
        value["id"] = serde_json::to_value(id).ok()?;
        serde_json::to_string(&value).ok()
    } else {
        Some(text.into())
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;

    #[test]
    fn reconnect_does_not_receive_predecessors_response_with_reused_id() {
        let request = r#"{"jsonrpc":"2.0","id":"req_1","method":"session.list"}"#;
        let old = prepare_request(request, "socket-a:").unwrap();
        let new = prepare_request(request, "socket-b:").unwrap();
        assert!(route_response(&old, "socket-b:").is_none());
        let restored: serde_json::Value =
            serde_json::from_str(&route_response(&new, "socket-b:").unwrap()).unwrap();
        assert_eq!(restored["id"], "req_1");
        let numeric = prepare_request(
            r#"{"jsonrpc":"2.0","id":7,"method":"daemon.health"}"#,
            "socket-c:",
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &route_response(&numeric, "socket-c:").unwrap()
            )
            .unwrap()["id"],
            7
        );
        assert_eq!(
            route_response(r#"{"method":"session.event","params":{}}"#, "socket-b:").unwrap(),
            r#"{"method":"session.event","params":{}}"#
        );
    }
}

async fn run_bridge(
    mut bridge: Bridge,
    mut requests: mpsc::Receiver<String>,
    responses: broadcast::Sender<Arc<str>>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            request = requests.recv() => {
                let Some(mut request) = request else { break };
                request.push('\n');
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    result = bridge.input.write_all(request.as_bytes()) => if result.is_err() { break; },
                }
            }
            line = bridge.output.next() => {
                let Ok(Some(line)) = line else { break };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { break };
                if !value.is_object() { break; }
                let _ = responses.send(Arc::from(line));
            }
        }
    }
    let _ = bridge.child.kill().await;
}
