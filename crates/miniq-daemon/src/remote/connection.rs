use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use super::transport::{self, Outbound};
use super::*;

struct Writer(JoinHandle<anyhow::Result<()>>);
impl Drop for Writer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

type RelaySocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(
    state: &AppState,
    config: &ActiveConfig,
) -> anyhow::Result<(RelaySocket, CryptoIdentity, RelayFrame)> {
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(&config.relay_url),
    )
    .await
    .map_err(|_| anyhow::anyhow!("连接 relay 超时"))??;
    let identity = derive_identity(&config.api_key);
    socket
        .send(Message::Text(
            json!({
                "type": "hello", "protocol": PROTOCOL_VERSION, "role": "desktop",
                "roomId": identity.room_id, "authToken": identity.auth_token,
                "deviceId": config.device_id, "deviceName": config.device_name,
            })
            .to_string()
            .into(),
        ))
        .await?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .map_err(|_| anyhow::anyhow!("relay 握手超时"))?
        .ok_or_else(|| anyhow::anyhow!("relay 在握手时关闭连接"))??;
    let ready = parse_relay_text(first)?;
    if ready.kind == "error" {
        anyhow::bail!(ready.message);
    }
    if ready.kind != "ready" || !ready.desktop_online {
        anyhow::bail!("relay 返回了无效握手响应");
    }
    set_status(
        state,
        RemoteConnectionState::Connected,
        config.relay_url.clone(),
        ready.mobile_clients,
        None,
    );
    tracing::info!(relay = %config.relay_url, "miniQ remote relay connected");
    Ok((socket, identity, ready))
}

pub(super) async fn run(state: &AppState, config: &ActiveConfig) -> anyhow::Result<()> {
    let (socket, identity, ready) = connect(state, config).await?;
    let (sink, mut incoming) = socket.split();
    let (outbound, messages) = mpsc::channel(32);
    let (controls, control_messages) = mpsc::unbounded_channel();
    let blobs = super::blob::BlobClient::new(controls.clone());
    let mut writer = Writer(tokio::spawn(transport::write(
        sink,
        identity.cipher.clone(),
        messages,
        control_messages,
    )));
    let mut requests = JoinSet::new();
    let mut cancellations = HashMap::<(String, String), CancellationToken>::new();
    let mut events = state.live_events.subscribe();
    let mut subscriptions = super::subscriptions::Subscriptions::default();
    let mut flush = tokio::time::interval(Duration::from_millis(700));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut config_check = tokio::time::interval(Duration::from_secs(2));
    let mut seen = SeenNonces::default();
    let mut mobile_clients = ready.mobile_clients;
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => return Ok(()),
            result = &mut writer.0 => { return result?; },
            Some(result) = requests.join_next() => { result??; },
            _ = config_check.tick() => {
                cancellations.retain(|_, token| !token.is_cancelled());
                if current_fingerprint(state) != Some(config.fingerprint) { return Ok(()); }
            }
            _ = flush.tick() => subscriptions.flush(&outbound),
            event = events.recv() => match event {
                Ok(event) if mobile_clients > 0 => subscriptions.event(event.projected.clone()),
                Ok(_) => {},
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    tracing::warn!(count, "remote client missed live events; requesting state resync");
                    subscriptions.resync();
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
            },
            message = incoming.next() => {
                let message = message.ok_or_else(|| anyhow::anyhow!("relay 已关闭连接"))??;
                match message {
                    Message::Ping(payload) => { controls.send(Message::Pong(payload))?; }
                    Message::Close(frame) => anyhow::bail!("relay 已关闭连接: {frame:?}"),
                    Message::Text(_) => {
                        let frame = parse_relay_text(message)?;
                        match frame.kind.as_str() {
                            "blob_ticket" => blobs.receive(&frame.request_id, frame.ticket),
                            "presence" => {
                                mobile_clients = frame.mobile_clients;
                                if let Some(ids) = &frame.mobile_ids { subscriptions.retain(ids); }
                                set_status(state, RemoteConnectionState::Connected, config.relay_url.clone(), mobile_clients, None);
                            }
                            "error" => anyhow::bail!(frame.message),
                            "frame" if !frame.source.is_empty() => {
                                if !seen.insert(format!("{}:{}", frame.source, frame.nonce)) { continue; }
                                let value: Value = match decrypt_payload(&identity.cipher, &frame.nonce, &frame.ciphertext)
                                    .and_then(|raw| Ok(serde_json::from_slice(&raw)?)) {
                                        Ok(value) => value,
                                        Err(_) => continue,
                                    };
                                if value["type"] == "remote_cancel" {
                                    if let Some(id) = value["requestId"].as_str() {
                                        if let Some(token) = cancellations.remove(&(frame.source.clone(), id.to_string())) { token.cancel(); }
                                    }
                                    continue;
                                }
                                subscriptions.observe(&frame.source, &value);
                                if value["type"] == "remote_select" { continue; }
                                cancellations.retain(|_, token| !token.is_cancelled());
                                let compress = value["acceptEncoding"] == "gzip";
                                let use_blob = ready.blob_storage && value["acceptBlob"] == true;
                                let request = serde_json::from_value::<RpcRequest>(value).map_err(Into::into);
                                if cancellations.len() >= 128 || requests.len() >= 128 {
                                    if let Ok(request) = &request {
                                        let busy = RpcResponse::err(request.id.clone(), RpcError::new(ErrorCode::SessionBusy, "远程请求过多，请稍后重试"));
                                        let _ = outbound.try_send(Outbound::new(frame.source, serde_json::to_value(busy)?));
                                    }
                                    continue;
                                }
                                let cancel = CancellationToken::new();
                                if let Ok(ref request) = request {
                                    let id = match &request.id { RequestId::String(id) => id.clone(), RequestId::Number(id) => id.to_string() };
                                    if let Some(previous) = cancellations.insert((frame.source.clone(), id), cancel.clone()) { previous.cancel(); }
                                }
                                let state = state.clone();
                                let outbound = outbound.clone();
                                let blobs = blobs.clone();
                                let cipher = identity.cipher.clone();
                                requests.spawn(async move {
                                    let response = dispatch(&state, request).await;
                                    let mut payload = serde_json::to_value(response)?;
                                    if use_blob && !cancel.is_cancelled() {
                                        match blobs.upload(&cipher, &payload, &cancel).await {
                                            Ok(Some(reference)) => payload = reference,
                                            Ok(None) => {},
                                            Err(_) => tracing::warn!("Object transfer unavailable; using encrypted WebSocket chunks"),
                                        }
                                    }
                                    // Cancel transport only; navigation must never cancel a user's running task.
                                    if !cancel.is_cancelled() {
                                        outbound.send(Outbound { target: frame.source, payload, cancel, compress }).await?;
                                    }
                                    Ok::<_, anyhow::Error>(())
                                });
                            }
                            _ => {},
                        }
                    }
                    _ => {},
                }
            }
        }
    }
}

async fn dispatch(state: &AppState, request: anyhow::Result<RpcRequest>) -> RpcResponse {
    match request {
        Ok(request) if remote_method_allowed(&request.method) => {
            crate::gateway::dispatch(state, request).await
        }
        Ok(request) => RpcResponse::err(
            request.id,
            RpcError::new(ErrorCode::Unauthorized, "该管理操作只能在桌面端执行"),
        ),
        Err(error) => RpcResponse::err(
            RequestId::Number(0),
            RpcError::new(ErrorCode::ParseError, format!("远程请求无效: {error}")),
        ),
    }
}

#[cfg(test)]
mod tests;
