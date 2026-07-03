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
    axum::serve(listener, router(state)).await?;
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
    let (mut sink, mut stream) = socket.split();
    let mut events = state.events.subscribe();
    // Channel that serializes everything written to the sink: RPC responses
    // and broadcast events both go through here.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);

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
            match events.recv().await {
                Ok(event) => {
                    let Ok(text) = serde_json::to_string(&event) else {
                        continue;
                    };
                    if event_tx.send(text).await.is_err() {
                        break;
                    }
                }
                // Slow consumer: skip missed events, keep the connection.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let response = match serde_json::from_str::<RpcRequest>(&text) {
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
