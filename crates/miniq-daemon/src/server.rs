//! WebSocket server: authentication, connection lifecycle, request/response
//! plumbing and event fan-out.

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use miniq_protocol::{ErrorCode, RequestId, RpcError, RpcRequest, RpcResponse};
use serde::Deserialize;
use tokio::net::TcpListener;

use crate::gateway;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_upgrade))
        .route("/health", get(http_health))
        .with_state(state)
}

/// Bind to a local port. `port = 0` picks a free ephemeral port.
pub async fn bind(port: u16) -> anyhow::Result<TcpListener> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    Ok(listener)
}

pub async fn serve(listener: TcpListener, state: AppState) -> anyhow::Result<()> {
    let shutdown = state.shutdown.clone();
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown.cancelled_owned())
        .await?;
    Ok(())
}

/// Plain HTTP health probe (no auth) used by the desktop shell to detect a
/// running daemon before opening the WebSocket.
async fn http_health() -> impl IntoResponse {
    axum::Json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
struct WsQuery {
    #[serde(default)]
    token: String,
}

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if query.token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let shutdown = state.shutdown.clone();
    let (mut sink, mut stream) = socket.split();
    let mut events = state.live_events.subscribe();
    let mut host_events = state.ssh_hosts.subscribe();
    // Channel that serializes everything written to the sink: RPC responses
    // and broadcast events both go through here.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
    let background_slots = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let host_slots = std::sync::Arc::new(tokio::sync::Semaphore::new(32));

    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(WsMessage::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let event_tx = tx.clone();
    let event_pump = tokio::spawn(async move {
        loop {
            let event = tokio::select! {
                event = events.recv() => event.map(|event| {
                    let mut value = serde_json::to_value(&event.original).expect("event serialization");
                    value["eventCursor"] = event.projected["eventCursor"].clone();
                    value
                }),
                event = host_events.recv() => event,
            };
            let value = match event {
                Ok(value) => value,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    serde_json::json!({"type":"remote_resync"})
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if event_tx.send(value.to_string()).await.is_err() {
                break;
            }
        }
    });

    loop {
        let msg = tokio::select! {
            _ = shutdown.cancelled() => break,
            msg = stream.next() => msg,
        };
        let Some(Ok(msg)) = msg else {
            break;
        };
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let request = serde_json::from_str::<RpcRequest>(&text);
        // Network-bound uploads and speech recognition must not block navigation
        // or task cancellation on this connection.
        if let Ok(req) = &request {
            let host_request = matches!(
                req.method.as_str(),
                "host.call" | "host.connect" | "host.disconnect"
            );
            if host_request
                || matches!(
                    req.method.as_str(),
                    "session.shareCreate"
                        | "session.shareList"
                        | "session.shareRevoke"
                        | "voice.transcribe"
                )
            {
                let slots = if host_request {
                    &host_slots
                } else {
                    &background_slots
                };
                if let Ok(permit) = slots.clone().try_acquire_owned() {
                    let req = request.unwrap();
                    let state = state.clone();
                    let replies = tx.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let response = gateway::dispatch(&state, req).await;
                        if let Ok(text) = serde_json::to_string(&response) {
                            let _ = replies.send(text).await;
                        }
                    });
                    continue;
                }
                let response = RpcResponse::err(
                    req.id.clone(),
                    RpcError::new(ErrorCode::SessionBusy, "后台请求繁忙，请稍后重试"),
                );
                if tx
                    .send(serde_json::to_string(&response).unwrap())
                    .await
                    .is_err()
                {
                    break;
                }
                continue;
            }
        }
        let response = match request {
            Ok(req) => gateway::dispatch(&state, req).await,
            Err(e) => RpcResponse::err(
                RequestId::Number(0),
                RpcError::new(ErrorCode::ParseError, format!("invalid request: {e}")),
            ),
        };
        let Ok(out) = serde_json::to_string(&response) else {
            continue;
        };
        if tx.send(out).await.is_err() {
            break;
        }
    }

    event_pump.abort();
    writer.abort();
}
