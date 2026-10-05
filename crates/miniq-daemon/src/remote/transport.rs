use std::{collections::VecDeque, io::Write, time::Duration};

use aes_gcm::Aes256Gcm;
use base64::Engine;
use futures_util::{Sink, SinkExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::{encrypt_payload, URL_SAFE_NO_PAD};

// Base64 inside encrypted JSON stays below the relay's 2 MiB wire limit.
pub(super) const CHUNK_BYTES: usize = 768 * 1024;
// Token bucket for encrypted frames. The relay allows 240 messages per
// 60s window per peer; a full burst plus one minute of refill is
// 20 + 3.5 * 60 = 230, leaving headroom for control messages.
pub(super) const FRAME_BURST: f64 = 20.0;
pub(super) const FRAME_REFILL_PER_SECOND: f64 = 3.5;
// Socket writes get a base budget plus time proportional to the frame size so
// a 2 MiB chunk on a slow uplink is not mistaken for a dead connection.
const SEND_TIMEOUT_BASE: Duration = Duration::from_secs(15);
const SEND_TIMEOUT_PER_STEP: Duration = Duration::from_secs(5);
const SEND_TIMEOUT_STEP_BYTES: usize = 128 * 1024;
const SEND_TIMEOUT_MAX: Duration = Duration::from_secs(120);

pub(super) struct Outbound {
    pub target: String,
    pub payload: Value,
    pub cancel: CancellationToken,
    pub compress: bool,
}

impl Outbound {
    pub fn new(target: String, payload: Value) -> Self {
        Self {
            target,
            payload,
            cancel: CancellationToken::new(),
            compress: false,
        }
    }
}

struct Transfer {
    target: String,
    bytes: Vec<u8>,
    offset: usize,
    id: String,
    request_id: Value,
    cancel: CancellationToken,
}

impl Transfer {
    fn new(message: Outbound) -> anyhow::Result<Self> {
        let bytes = encode(&message.payload, message.compress)?;
        Ok(Self {
            target: message.target,
            bytes,
            offset: 0,
            id: format!("{:032x}", rand::random::<u128>()),
            request_id: message
                .payload
                .get("id")
                .or_else(|| message.payload.get("requestId"))
                .cloned()
                .unwrap_or(Value::Null),
            cancel: message.cancel,
        })
    }

    fn small_reply(&self) -> bool {
        !self.request_id.is_null() && self.bytes.len() <= CHUNK_BYTES
    }

    fn frame(&mut self, cipher: &Aes256Gcm) -> anyhow::Result<Message> {
        let end = (self.offset + CHUNK_BYTES).min(self.bytes.len());
        let frame = if self.bytes.len() <= CHUNK_BYTES {
            encrypted_frame(cipher, &self.target, &self.bytes)?
        } else {
            let fragment = json!({
                "type": "remote_chunk", "transferId": self.id,
                "index": self.offset / CHUNK_BYTES, "totalBytes": self.bytes.len(),
                "requestId": self.request_id,
                "data": URL_SAFE_NO_PAD.encode(&self.bytes[self.offset..end]),
            });
            encrypted_frame(cipher, &self.target, &serde_json::to_vec(&fragment)?)?
        };
        self.offset = end;
        Ok(frame)
    }
}

impl Drop for Transfer {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

pub(super) fn encode(payload: &Value, compress: bool) -> anyhow::Result<Vec<u8>> {
    let plain = serde_json::to_vec(payload)?;
    if !compress || plain.len() < 16 * 1024 {
        return Ok(plain);
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(3));
    encoder.write_all(&plain)?;
    let compressed = serde_json::to_vec(&json!({
        "type": "remote_compressed", "encoding": "gzip",
        "requestId": payload.get("id"), "uncompressedBytes": plain.len(),
        "data": URL_SAFE_NO_PAD.encode(encoder.finish()?),
    }))?;
    Ok(if compressed.len() < plain.len() {
        compressed
    } else {
        plain
    })
}

pub(super) async fn write<S>(
    mut sink: S,
    cipher: Aes256Gcm,
    mut messages: mpsc::Receiver<Outbound>,
    mut controls: mpsc::UnboundedReceiver<Message>,
) -> anyhow::Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let mut budget = FrameBudget::new(tokio::time::Instant::now());
    let mut queued = VecDeque::<Transfer>::new();
    let mut closed = false;
    let mut urgent_frames = 0;
    loop {
        queued.retain(|transfer| !transfer.cancel.is_cancelled());
        if closed && queued.is_empty() {
            return Ok(());
        }
        tokio::select! {
            biased;
            control = controls.recv() => match control {
                Some(control) => send(&mut sink, control).await?,
                None => return Ok(()),
            },
            message = messages.recv(), if !closed && queued.len() < 32 => match message {
                Some(message) if !message.cancel.is_cancelled() => queued.push_back(Transfer::new(message)?),
                Some(_) => {},
                None => closed = true,
            },
            _ = tokio::time::sleep_until(budget.ready_at(tokio::time::Instant::now())), if !queued.is_empty() => {
                // RPC replies may pass bulk transfers; event batches keep their original order.
                // A bounded priority burst keeps history/export downloads making progress too.
                let index = if urgent_frames < 4 {
                    queued.iter().position(Transfer::small_reply).unwrap_or(0)
                } else { 0 };
                let mut transfer = queued.remove(index).expect("nonempty queue");
                if transfer.cancel.is_cancelled() { continue; }
                urgent_frames = if index > 0 { urgent_frames + 1 } else { 0 };
                budget.take(tokio::time::Instant::now());
                send(&mut sink, transfer.frame(&cipher)?).await?;
                if transfer.offset < transfer.bytes.len() { queued.insert(index, transfer); }
            }
        }
    }
}

fn encrypted_frame(cipher: &Aes256Gcm, target: &str, payload: &[u8]) -> anyhow::Result<Message> {
    let (nonce, ciphertext) = encrypt_payload(cipher, payload)?;
    Ok(Message::Text(
        json!({
            "type": "frame", "target": target, "nonce": nonce, "ciphertext": ciphertext,
        })
        .to_string()
        .into(),
    ))
}

async fn send<S>(sink: &mut S, message: Message) -> anyhow::Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let limit = send_timeout(message.len());
    tokio::time::timeout(limit, sink.send(message)).await??;
    Ok(())
}

pub(super) fn send_timeout(bytes: usize) -> Duration {
    let steps = u32::try_from(bytes / SEND_TIMEOUT_STEP_BYTES).unwrap_or(u32::MAX);
    SEND_TIMEOUT_BASE
        .saturating_add(SEND_TIMEOUT_PER_STEP.saturating_mul(steps))
        .min(SEND_TIMEOUT_MAX)
}

/// Relay frame budget: up to [`FRAME_BURST`] frames at once, refilled at
/// [`FRAME_REFILL_PER_SECOND`].
pub(super) struct FrameBudget {
    tokens: f64,
    updated: tokio::time::Instant,
}

impl FrameBudget {
    pub(super) fn new(now: tokio::time::Instant) -> Self {
        Self {
            tokens: FRAME_BURST,
            updated: now,
        }
    }

    fn refill(&mut self, now: tokio::time::Instant) {
        let elapsed = now.saturating_duration_since(self.updated).as_secs_f64();
        self.tokens = (self.tokens + elapsed * FRAME_REFILL_PER_SECOND).min(FRAME_BURST);
        self.updated = now;
    }

    /// Earliest instant at which one whole frame token is available.
    pub(super) fn ready_at(&mut self, now: tokio::time::Instant) -> tokio::time::Instant {
        self.refill(now);
        let missing = (1.0 - self.tokens).max(0.0);
        now + Duration::from_secs_f64(missing / FRAME_REFILL_PER_SECOND)
    }

    pub(super) fn take(&mut self, now: tokio::time::Instant) {
        self.refill(now);
        self.tokens -= 1.0;
    }
}

#[cfg(test)]
mod tests;
