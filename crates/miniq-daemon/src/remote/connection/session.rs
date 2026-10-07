//! Per-connection state and inbound relay message handling.

use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::transport::Outbound;
use super::super::*;
use super::requests::Requests;

/// What the connection loop should do after an inbound relay message.
pub(super) enum Inbound {
    Continue,
    Closed(anyhow::Error),
}

pub(super) struct Session<'a> {
    pub state: &'a AppState,
    pub config: &'a ActiveConfig,
    pub cipher: aes_gcm::Aes256Gcm,
    pub blob_storage: bool,
    pub outbound: mpsc::Sender<Outbound>,
    pub controls: mpsc::UnboundedSender<Message>,
    pub blobs: super::super::blob::BlobClient,
    pub requests: Requests,
    pub uploads: super::super::upload::Uploads,
    pub subscriptions: super::super::subscriptions::Subscriptions,
    pub seen: SeenNonces,
    pub mobile_clients: usize,
    pub pushes: super::super::push::PushTracker,
}

impl Session<'_> {
    /// Handles one text frame from the relay. Only an explicit relay rejection
    /// other than rate limiting closes the connection.
    pub fn handle_text(&mut self, message: Message) -> anyhow::Result<Inbound> {
        let frame = parse_relay_text(message)?;
        match frame.kind.as_str() {
            "blob_ticket" => self.blobs.receive(&frame.request_id, frame.ticket),
            "presence" => {
                self.mobile_clients = frame.mobile_clients;
                if let Some(ids) = &frame.mobile_ids {
                    self.subscriptions.retain(ids);
                    self.uploads.retain_sources(ids);
                }
                set_status(
                    self.state,
                    RemoteConnectionState::Connected,
                    self.config.relay_url.clone(),
                    self.mobile_clients,
                    None,
                );
            }
            // Throttling is transient: keep the session and let the relay
            // decide whether to close the socket.
            "error" if frame.code == "rate_limited" => {
                tracing::warn!(message = %frame.message, "miniQ remote relay rate limited this desktop");
            }
            "error" => return Ok(Inbound::Closed(anyhow::anyhow!(frame.message))),
            "frame" if !frame.source.is_empty() => self.handle_frame(frame)?,
            _ => {}
        }
        Ok(Inbound::Continue)
    }

    fn handle_frame(&mut self, frame: RelayFrame) -> anyhow::Result<()> {
        if !self
            .seen
            .insert(format!("{}:{}", frame.source, frame.nonce))
        {
            return Ok(());
        }
        let Ok(value) = decrypt_payload(&self.cipher, &frame.nonce, &frame.ciphertext)
            .and_then(|raw| Ok(serde_json::from_slice::<Value>(&raw)?))
        else {
            return Ok(());
        };
        if value["type"] == "remote_cancel" {
            if let Some(id) = value["requestId"].as_str() {
                self.uploads.cancel(&frame.source, id);
                self.requests.cancel(&frame.source, id);
            }
            return Ok(());
        }
        let upload_request_id = value.get("requestId").cloned();
        let value = match self.uploads.read(&frame.source, value) {
            Ok(Some(value)) => value,
            Ok(None) => return Ok(()),
            Err(error) => {
                if let Some(id) =
                    upload_request_id.and_then(|id| serde_json::from_value::<RequestId>(id).ok())
                {
                    let error =
                        RpcError::new(ErrorCode::InvalidParams, format!("远程上传无效：{error}"));
                    self.reply(frame.source, RpcResponse::err(id, error))?;
                }
                return Ok(());
            }
        };
        self.subscriptions.observe(&frame.source, &value);
        if value["type"] == "remote_select" {
            return Ok(());
        }
        self.spawn_request(frame.source, value)
    }

    fn spawn_request(&mut self, source: String, value: Value) -> anyhow::Result<()> {
        let compress = value["acceptEncoding"] == "gzip";
        let use_blob = self.blob_storage && value["acceptBlob"] == true;
        let request = serde_json::from_value::<RpcRequest>(value).map_err(anyhow::Error::from);
        if self.requests.is_full() {
            if let Ok(request) = &request {
                let error = RpcError::new(ErrorCode::SessionBusy, "远程请求过多，请稍后重试");
                self.reply(source, RpcResponse::err(request.id.clone(), error))?;
            }
            return Ok(());
        }
        let key = request.as_ref().ok().map(|request| {
            let id = match &request.id {
                RequestId::String(id) => id.clone(),
                RequestId::Number(id) => id.to_string(),
            };
            (source.clone(), id)
        });
        let cancel = CancellationToken::new();
        let state = self.state.clone();
        let outbound = self.outbound.clone();
        let blobs = self.blobs.clone();
        let cipher = self.cipher.clone();
        let token = cancel.clone();
        self.requests.spawn(key, cancel, async move {
            let response = super::dispatch(&state, &source, request).await;
            let mut payload = serde_json::to_value(response)?;
            if use_blob && !token.is_cancelled() {
                match blobs.upload(&cipher, &payload, &token).await {
                    Ok(Some(reference)) => payload = reference,
                    Ok(None) => {}
                    Err(_) => {
                        tracing::warn!(
                            "Object transfer unavailable; using encrypted WebSocket chunks"
                        )
                    }
                }
            }
            // Cancel transport only; navigation must never cancel a user's running task.
            if !token.is_cancelled() {
                let reply = Outbound {
                    target: source,
                    payload,
                    cancel: token,
                    compress,
                };
                outbound.send(reply).await?;
            }
            Ok(())
        });
        Ok(())
    }

    fn reply(&mut self, target: String, response: RpcResponse) -> anyhow::Result<()> {
        let outbound = Outbound::new(target, serde_json::to_value(response)?);
        self.requests.reply(&self.outbound, outbound);
        Ok(())
    }

    pub fn live_event(&mut self, event: std::sync::Arc<crate::event_journal::LiveEvent>) {
        if super::push_candidate(&event.original) {
            // Push frames are emitted even with no phone online: the relay
            // decides whether a system notification is needed.
            if let Some(push) = self
                .pushes
                .observe(&event.original, std::time::Instant::now())
            {
                match super::super::push::push_message(self.state, self.config, &self.cipher, &push)
                {
                    Ok(message) => {
                        let _ = self
                            .controls
                            .send(Message::Text(message.to_string().into()));
                    }
                    Err(error) => tracing::warn!(%error, "failed to build remote push frame"),
                }
            }
        } else if matches!(
            event.original,
            miniq_protocol::Event::BrowserDriverRequested { .. }
        ) {
            return;
        }
        if self.mobile_clients > 0 {
            self.subscriptions.event(event.projected.clone());
        }
    }

    pub fn host_event(&mut self, event: Value) {
        if self.mobile_clients > 0 {
            if let Some(event) = super::project_host_event(event) {
                self.subscriptions.event(event);
            }
        }
    }
}
