use std::{
    collections::VecDeque,
    io::Write,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use aes_gcm::Aes256Gcm;
use base64::Engine;
use futures_util::{stream::FuturesOrdered, Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

use super::{encrypt_payload, URL_SAFE_NO_PAD};

// Base64 inside encrypted JSON stays below the relay's 2 MiB wire limit.
pub(super) const CHUNK_BYTES: usize = 768 * 1024;
// Objects are only worthwhile after the direct encrypted WebSocket chunk
// limit. Smaller replies avoid the ticket + PUT + GET round trip entirely.
pub(super) const BLOB_MIN_BYTES: usize = CHUNK_BYTES;
pub(super) const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;
const PREPARE_CONCURRENCY: usize = 2;
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
    pub prepared: Option<PreparedBytes>,
}

/// JSON serialization and optional gzip output shared by WebSocket and blob
/// transport. The bytes are reference counted so blob fallback can reuse the
/// exact same encoded representation without another compression pass.
#[derive(Clone)]
pub(super) struct PreparedBytes {
    bytes: Arc<[u8]>,
}

impl PreparedBytes {
    pub(super) fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    pub(super) fn len(&self) -> usize {
        self.bytes.len()
    }
}

impl Outbound {
    pub fn new(target: String, payload: Value) -> Self {
        Self {
            target,
            payload,
            cancel: CancellationToken::new(),
            compress: false,
            prepared: None,
        }
    }
}

struct Transfer {
    target: String,
    bytes: Arc<[u8]>,
    offset: usize,
    id: String,
    request_id: Value,
    cancel: CancellationToken,
}

impl Transfer {
    fn new(message: Outbound, prepared: PreparedBytes) -> Self {
        Self {
            target: message.target,
            bytes: prepared.bytes,
            offset: 0,
            id: format!("{:032x}", rand::random::<u128>()),
            request_id: message
                .payload
                .get("id")
                .or_else(|| message.payload.get("requestId"))
                .cloned()
                .unwrap_or(Value::Null),
            cancel: message.cancel,
        }
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

#[cfg(test)]
pub(super) fn encode(payload: &Value, compress: bool) -> anyhow::Result<Vec<u8>> {
    let plain = serde_json::to_vec(payload)?;
    encode_plain(payload, plain, compress)
}

fn encode_plain(payload: &Value, plain: Vec<u8>, compress: bool) -> anyhow::Result<Vec<u8>> {
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

fn prepare_limit() -> &'static Arc<Semaphore> {
    static LIMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMIT.get_or_init(|| Arc::new(Semaphore::new(PREPARE_CONCURRENCY)))
}

fn prepare_sync(payload: Value, compress: bool) -> anyhow::Result<PreparedBytes> {
    #[cfg(test)]
    {
        let delay = if payload["id"] == "slow" {
            PREPARE_DELAY_MS.load(Ordering::Relaxed)
        } else {
            0
        };
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
    }
    let started = Instant::now();
    let plain = serde_json::to_vec(&payload)?;
    let plain_bytes = plain.len();
    let bytes = encode_plain(&payload, plain, compress)?;
    let encoded_bytes = bytes.len();
    tracing::info!(
        target: "miniq.perf",
        operation = "remote.encode",
        plain_bytes,
        encoded_bytes,
        compression_requested = compress,
        compression_used = encoded_bytes < plain_bytes,
        compression_ratio = encoded_bytes as f64 / plain_bytes.max(1) as f64,
        encoding_elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
        "remote payload encoded"
    );
    Ok(PreparedBytes {
        bytes: bytes.into(),
    })
}

#[cfg(test)]
static PREPARE_DELAY_MS: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
struct PrepareDelayGuard;

#[cfg(test)]
impl Drop for PrepareDelayGuard {
    fn drop(&mut self) {
        PREPARE_DELAY_MS.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
fn prepare_delay(delay: Duration) -> PrepareDelayGuard {
    PREPARE_DELAY_MS.store(
        delay.as_millis().try_into().unwrap_or(u64::MAX),
        Ordering::Relaxed,
    );
    PrepareDelayGuard
}

/// Prepare outside the writer and cap the number of blocking encoders. A
/// cancelled caller stops waiting immediately; the blocking job retains its
/// permit until it exits so cancellation cannot defeat the bound.
pub(super) async fn prepare(
    payload: Value,
    compress: bool,
    cancel: &CancellationToken,
) -> anyhow::Result<Option<PreparedBytes>> {
    let permit = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(None),
        permit = prepare_limit().clone().acquire_owned() => permit?,
    };
    let job = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        prepare_sync(payload, compress)
    });
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Ok(None),
        result = job => Ok(Some(result??)),
    }
}

async fn prepare_message(message: Outbound) -> anyhow::Result<Option<Transfer>> {
    if message.cancel.is_cancelled() {
        return Ok(None);
    }
    let prepared = match message.prepared.clone() {
        Some(prepared) => prepared,
        None => match prepare(message.payload.clone(), message.compress, &message.cancel).await? {
            Some(prepared) => prepared,
            None => return Ok(None),
        },
    };
    if message.cancel.is_cancelled() {
        return Ok(None);
    }
    Ok(Some(Transfer::new(message, prepared)))
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
    // Preparation may run concurrently, but event batches must enter the
    // sending queue in their original order so cursors cannot skip events.
    let mut preparations = FuturesOrdered::new();
    let mut closed = false;
    let mut urgent_frames = 0;
    loop {
        queued.retain(|transfer| !transfer.cancel.is_cancelled());
        if closed && queued.is_empty() && preparations.is_empty() {
            return Ok(());
        }
        tokio::select! {
            biased;
            control = controls.recv() => match control {
                Some(control) => send(&mut sink, control).await?,
                None => return Ok(()),
            },
            message = messages.recv(), if !closed && queued.len() + preparations.len() < 32 => match message {
                Some(message) if !message.cancel.is_cancelled() => {
                    preparations.push_back(prepare_message(message));
                }
                Some(_) => {},
                None => closed = true,
            },
            prepared = preparations.next(), if !preparations.is_empty() => match prepared {
                Some(Ok(Some(transfer))) => queued.push_back(transfer),
                Some(Ok(None)) => {},
                Some(Err(error)) => return Err(error),
                None => {},
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
