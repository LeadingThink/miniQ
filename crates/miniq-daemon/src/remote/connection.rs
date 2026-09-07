use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};

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
    let mut writer = Writer(tokio::spawn(transport::write(
        sink,
        identity.cipher.clone(),
        messages,
        control_messages,
    )));
    let mut requests = JoinSet::new();
    let mut events = state.events.subscribe();
    let mut buffered = Vec::<Value>::new();
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
                if current_fingerprint(state) != Some(config.fingerprint) { return Ok(()); }
            }
            _ = flush.tick(), if !buffered.is_empty() => {
                if let Ok(permit) = outbound.try_reserve() {
                    permit.send(Outbound { target: "mobiles".into(), payload: json!({
                        "type": "remote_batch", "items": std::mem::take(&mut buffered),
                    }) });
                }
            }
            event = events.recv() => match event {
                Ok(event) if mobile_clients > 0 => buffered.push(serde_json::to_value(event)?),
                Ok(_) => {},
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    tracing::warn!(count, "remote client missed live events; requesting state resync");
                    buffered.push(json!({"type": "remote_resync"}));
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
                            "presence" => {
                                mobile_clients = frame.mobile_clients;
                                set_status(state, RemoteConnectionState::Connected, config.relay_url.clone(), mobile_clients, None);
                            }
                            "error" => anyhow::bail!(frame.message),
                            "frame" if !frame.source.is_empty() => {
                                if !seen.insert(format!("{}:{}", frame.source, frame.nonce)) { continue; }
                                let request = decrypt_payload(&identity.cipher, &frame.nonce, &frame.ciphertext)
                                    .and_then(|raw| Ok(serde_json::from_slice::<RpcRequest>(&raw)?));
                                let state = state.clone();
                                let outbound = outbound.clone();
                                requests.spawn(async move {
                                    let response = dispatch(&state, request).await;
                                    outbound.send(Outbound { target: frame.source, payload: serde_json::to_value(response)? }).await?;
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
