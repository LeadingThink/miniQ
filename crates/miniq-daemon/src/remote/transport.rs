use std::time::Duration;

use aes_gcm::Aes256Gcm;
use base64::Engine;
use futures_util::{Sink, SinkExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::{encrypt_payload, URL_SAFE_NO_PAD};

// Base64 inside encrypted JSON stays below the relay's 2 MiB wire limit.
pub(super) const CHUNK_BYTES: usize = 768 * 1024;
// Leave headroom below the relay's 240 frames/minute per-peer budget.
const FRAME_INTERVAL: Duration = Duration::from_millis(350);

pub(super) struct Outbound {
    pub target: String,
    pub payload: Value,
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
    loop {
        tokio::select! {
            biased;
            control = controls.recv() => match control {
                Some(control) => send(&mut sink, control).await?,
                None => return Ok(()),
            },
            message = messages.recv() => {
                let Some(message) = message else { return Ok(()) };
                let payload = serde_json::to_vec(&message.payload)?;
                let transfer = format!("{:032x}", rand::random::<u128>());
                for (index, chunk) in payload.chunks(CHUNK_BYTES).enumerate() {
                    // Pongs must continue while a large session is being sent.
                    loop {
                        tokio::select! {
                            biased;
                            control = controls.recv() => match control {
                                Some(control) => send(&mut sink, control).await?,
                                None => return Ok(()),
                            },
                            _ = tokio::time::sleep_until(next_frame) => break,
                        }
                    }
                    let wire = if payload.len() <= CHUNK_BYTES {
                        encrypted_frame(&cipher, &message.target, &payload)?
                    } else {
                        let fragment = json!({
                            "type": "remote_chunk", "transferId": transfer,
                            "index": index, "totalBytes": payload.len(),
                            "requestId": message.payload.get("id"),
                            "data": URL_SAFE_NO_PAD.encode(chunk),
                        });
                        encrypted_frame(&cipher, &message.target, &serde_json::to_vec(&fragment)?)?
                    };
                    send(&mut sink, wire).await?;
                    next_frame = tokio::time::Instant::now() + FRAME_INTERVAL;
                }
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
