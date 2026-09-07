//! Private object data plane. Tickets carry no session data; objects are AES-GCM ciphertext.
use super::{encrypt_bytes, transport::encode, URL_SAFE_NO_PAD};
use aes_gcm::Aes256Gcm;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Ticket {
    put_url: String,
    get_url: String,
    expires_at: u64,
}

type Tickets = Arc<Mutex<HashMap<String, oneshot::Sender<Option<Ticket>>>>>;

#[derive(Clone)]
pub(super) struct BlobClient {
    tickets: Tickets,
    controls: mpsc::UnboundedSender<Message>,
    http: reqwest::Client,
}

struct PendingTicket {
    id: String,
    tickets: Tickets,
}
impl Drop for PendingTicket {
    fn drop(&mut self) {
        self.tickets.lock().unwrap().remove(&self.id);
    }
}

impl BlobClient {
    pub fn new(controls: mpsc::UnboundedSender<Message>) -> Self {
        Self {
            tickets: Arc::default(),
            controls,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(25))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
        }
    }
    pub fn receive(&self, id: &str, ticket: Option<Ticket>) {
        if let Some(sender) = self.tickets.lock().unwrap().remove(id) {
            let _ = sender.send(ticket);
        }
    }
    pub async fn upload(
        &self,
        cipher: &Aes256Gcm,
        payload: &Value,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Option<Value>> {
        let source = payload.clone();
        let encoded = tokio::task::spawn_blocking(move || encode(&source, true)).await??;
        if encoded.len() < 128 * 1024 || encoded.len() + 16 > 64 * 1024 * 1024 {
            return Ok(None);
        }
        tokio::select! {
            _ = cancel.cancelled() => Ok(None),
            result = self.upload_bytes(cipher, payload.get("id"), &encoded) => result.map(Some),
        }
    }
    async fn upload_bytes(
        &self,
        cipher: &Aes256Gcm,
        request_id: Option<&Value>,
        encoded: &[u8],
    ) -> anyhow::Result<Value> {
        let (nonce, bytes) = encrypt_bytes(cipher, encoded)?;
        let id = format!("blob-{:032x}", rand::random::<u128>());
        let (tx, rx) = oneshot::channel();
        self.tickets.lock().unwrap().insert(id.clone(), tx);
        let _pending = PendingTicket {
            id: id.clone(),
            tickets: self.tickets.clone(),
        };
        self.controls.send(Message::Text(
            json!({"type":"blob_ticket", "requestId":id, "bytes":bytes.len()})
                .to_string()
                .into(),
        ))?;
        let ticket = tokio::time::timeout(Duration::from_secs(10), rx)
            .await??
            .ok_or_else(|| anyhow::anyhow!("Object transfer unavailable"))?;
        validate_url(&ticket.put_url)?;
        validate_url(&ticket.get_url)?;
        let size = bytes.len();
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let response = self
            .http
            .put(&ticket.put_url)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("Object upload failed ({})", response.status().as_u16());
        }
        Ok(
            json!({"type":"remote_blob", "requestId":request_id, "url":ticket.get_url,
            "nonce":URL_SAFE_NO_PAD.encode(nonce), "bytes":size, "sha256":sha256, "expiresAt":ticket.expires_at}),
        )
    }
}

fn validate_url(raw: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(raw)?;
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|host| host.ends_with(".qiniucs.com"))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        anyhow::bail!("Invalid private object endpoint");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tickets_cannot_redirect_payloads_to_untrusted_hosts() {
        for url in [
            "http://s3-cn-south-1.qiniucs.com/a",
            "https://qiniucs.com.evil.invalid/a",
            "https://127.0.0.1/a",
            "https://u:p@s3-cn-south-1.qiniucs.com/a",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert!(validate_url("https://s3-cn-south-1.qiniucs.com/bucket/key?signature=x").is_ok());
    }
}
