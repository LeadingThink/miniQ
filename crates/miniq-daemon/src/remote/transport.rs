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
// Leave headroom below the relay's 240 frames/minute per-peer budget.
const FRAME_INTERVAL: Duration = Duration::from_millis(350);

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
    let mut next_frame = tokio::time::Instant::now();
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
            _ = tokio::time::sleep_until(next_frame), if !queued.is_empty() => {
                // RPC replies may pass bulk transfers; event batches keep their original order.
                // A bounded priority burst keeps history/export downloads making progress too.
                let index = if urgent_frames < 4 {
                    queued.iter().position(Transfer::small_reply).unwrap_or(0)
                } else { 0 };
                let mut transfer = queued.remove(index).expect("nonempty queue");
                if transfer.cancel.is_cancelled() { continue; }
                urgent_frames = if index > 0 { urgent_frames + 1 } else { 0 };
                send(&mut sink, transfer.frame(&cipher)?).await?;
                if transfer.offset < transfer.bytes.len() { queued.insert(index, transfer); }
                next_frame = tokio::time::Instant::now() + FRAME_INTERVAL;
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
    tokio::time::timeout(Duration::from_secs(15), sink.send(message)).await??;
    Ok(())
}

#[cfg(test)]
mod tests;
