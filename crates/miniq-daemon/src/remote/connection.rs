use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::transport;
use super::*;

mod requests;
mod session;

use requests::Requests;
use session::{Inbound, Session};

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
    if ready.kind != "ready" || !ready.desktop_online || ready.desktop_device_id != config.device_id
    {
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

pub(super) async fn run(
    state: &AppState,
    config: &ActiveConfig,
    on_ready: impl FnOnce(),
) -> anyhow::Result<()> {
    let (socket, identity, ready) = connect(state, config).await?;
    on_ready();
    let (sink, incoming) = socket.split();
    let (outbound, messages) = mpsc::channel(32);
    let (controls, control_messages) = mpsc::unbounded_channel();
    let writer = Writer(tokio::spawn(transport::write(
        sink,
        identity.cipher.clone(),
        messages,
        control_messages,
    )));
    let session = Session {
        state,
        config,
        cipher: identity.cipher,
        blob_storage: ready.blob_storage,
        outbound,
        blobs: super::blob::BlobClient::new(controls.clone()),
        controls,
        requests: Requests::default(),
        uploads: super::upload::Uploads::default(),
        subscriptions: super::subscriptions::Subscriptions::default(),
        seen: SeenNonces::default(),
        mobile_clients: ready.mobile_clients,
        pushes: super::push::PushTracker::default(),
    };
    serve(session, writer, incoming).await
}

async fn serve(
    mut session: Session<'_>,
    mut writer: Writer,
    mut incoming: futures_util::stream::SplitStream<RelaySocket>,
) -> anyhow::Result<()> {
    let state = session.state;
    let mut events = state.live_events.subscribe();
    let mut host_events = state.ssh_hosts.subscribe();
    let mut flush = tokio::time::interval(Duration::from_millis(700));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut config_check = tokio::time::interval(Duration::from_secs(2));
    // Desktop-initiated pings keep NAT/proxy paths warm and make the relay
    // answer with pongs, so a silent dead path is detected well before the
    // relay's own 30s heartbeat and the 15s reconnect grace overlap.
    let mut ping = tokio::time::interval_at(
        tokio::time::Instant::now() + DESKTOP_PING_INTERVAL,
        DESKTOP_PING_INTERVAL,
    );
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_inbound = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => { say_goodbye(&session.controls).await; return Ok(()); },
            result = &mut writer.0 => { return result?; },
            () = session.requests.join_next() => {},
            _ = ping.tick() => { session.controls.send(Message::Ping(Vec::new().into()))?; },
            _ = config_check.tick() => {
                session.uploads.expire();
                if current_fingerprint(state) != Some(session.config.fingerprint) {
                    say_goodbye(&session.controls).await;
                    return Ok(());
                }
                if last_inbound.elapsed() > RELAY_IDLE_TIMEOUT { anyhow::bail!("relay 心跳超时"); }
            }
            _ = flush.tick() => session.subscriptions.flush(&session.outbound),
            event = events.recv() => match event {
                Ok(event) => session.live_event(event),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    tracing::warn!(count, "remote client missed live events; requesting state resync");
                    session.subscriptions.resync();
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
            },
            event = host_events.recv() => match event {
                Ok(event) => session.host_event(event),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => session.subscriptions.resync(),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
            },
            message = incoming.next() => {
                let message = message.ok_or_else(|| anyhow::anyhow!("relay 已关闭连接"))??;
                last_inbound = tokio::time::Instant::now();
                // Pings are answered by tungstenite itself on the read path.
                match message {
                    Message::Close(frame) => anyhow::bail!("relay 已关闭连接: {frame:?}"),
                    Message::Text(_) => {
                        if let Inbound::Closed(error) = session.handle_text(message)? {
                            return Err(error);
                        }
                    }
                    _ => {},
                }
            }
        }
    }
}

async fn dispatch(
    state: &AppState,
    source: &str,
    request: anyhow::Result<RpcRequest>,
) -> RpcResponse {
    match request {
        // The relay is untrusted: always stamp the origin server-side so a
        // client can never claim to be local. The gateway enforces the
        // per-method remote policy for every remote origin.
        Ok(request) => {
            let device = if source.is_empty() { "unknown" } else { source };
            let request = request.with_origin(Some(format!("remote:{device}")));
            crate::gateway::dispatch(state, request).await
        }
        Err(error) => RpcResponse::err(
            RequestId::Number(0),
            RpcError::new(ErrorCode::ParseError, format!("远程请求无效: {error}")),
        ),
    }
}

/// Three missed desktop pings: the relay answers every ping with a pong.
const RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const DESKTOP_PING_INTERVAL: Duration = Duration::from_secs(15);

/// Tells the relay this disconnect is intentional (quit / remote access turned
/// off or reconfigured), so phones do not get a "desktop offline" push.
async fn say_goodbye(controls: &mpsc::UnboundedSender<Message>) {
    let goodbye = json!({"type": "desktop_goodbye"}).to_string();
    if controls.send(Message::Text(goodbye.into())).is_ok() {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn push_candidate(event: &miniq_protocol::Event) -> bool {
    use miniq_protocol::Event;
    matches!(
        event,
        Event::SessionStatusChanged { .. }
            | Event::TurnCompleted { .. }
            | Event::TurnFailed { .. }
            | Event::SessionDeleted { .. }
            | Event::ApprovalRequested { .. }
            | Event::QuestionRequested { .. }
    )
}

fn project_host_event(mut envelope: Value) -> Option<Value> {
    if envelope["type"] == "host_event" {
        if envelope["event"]["type"] == "browser_driver_requested" {
            return None;
        }
        envelope["event"] = crate::event_journal::project_event(envelope["event"].take());
    }
    Some(envelope)
}

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod host_tests;
