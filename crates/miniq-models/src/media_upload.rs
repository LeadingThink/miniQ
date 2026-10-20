//! Raw media uses a separate short-lived private object, never RPC ciphertext.
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

const ENDPOINT: &str = "https://oneapi.zaiwenai.com/miniq-relay/provider-media/ticket";

pub fn provider_media_uploader(
    base_url: &str,
    api_key: &str,
    cancel: CancellationToken,
) -> Option<Arc<dyn ProviderMediaUploader>> {
    // Custom provider credentials must never be sent to the default OneAPI service.
    let url = reqwest::Url::parse(base_url).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("oneapi.zaiwenai.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(Arc::new(HttpUploader {
        key: api_key.to_owned(),
        cancel,
        endpoint: ENDPOINT.into(),
    }))
}

struct HttpUploader {
    key: String,
    cancel: CancellationToken,
    endpoint: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    put_url: String,
    get_url: String,
    expires_at: u64,
}
#[derive(Deserialize)]
struct TicketResponse {
    ticket: Ticket,
}

pub(crate) fn storage_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid media storage URL")?;
    if url.scheme() != "https"
        || !url.host_str().is_some_and(|h| h.ends_with(".qiniucs.com"))
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid media storage URL".into());
    }
    Ok(url)
}

#[async_trait]
impl ProviderMediaUploader for HttpUploader {
    async fn upload(
        &self,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<ProviderMediaReference, String> {
        static UPLOADS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
        let limits = UPLOADS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)));
        let size = bytes.len();
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "Media HTTP client unavailable")?;
        let mut last_error = None;
        for attempt in 0..MAX_UPLOAD_ATTEMPTS {
            let result = tokio::select! {
                _ = self.cancel.cancelled() => return Err("Media upload cancelled".into()),
                result = self.upload_once(&http, &limits, &bytes, content_type, size) => result,
            };
            match result {
                Ok(reference) => return Ok(reference),
                Err(UploadFailure::Permanent(error)) => return Err(error),
                Err(UploadFailure::Retryable(error)) => {
                    last_error = Some(error);
                    if attempt + 1 < MAX_UPLOAD_ATTEMPTS {
                        let delay = RETRY_DELAYS[attempt];
                        tokio::select! {
                            _ = self.cancel.cancelled() => return Err("Media upload cancelled".into()),
                            _ = tokio::time::sleep(delay) => {}
                        }
                    }
                }
            }
        }
        Err(last_error.unwrap_or_else(|| "Media upload failed".into()))
    }

    fn cache_namespace(&self) -> Option<String> {
        let mut digest = Sha256::new();
        digest.update(self.endpoint.as_bytes());
        digest.update([0]);
        digest.update(self.key.as_bytes());
        Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.finalize()))
    }
}

const MAX_UPLOAD_ATTEMPTS: usize = 3;
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(100), Duration::from_millis(250)];

enum UploadFailure {
    Retryable(String),
    Permanent(String),
}

impl HttpUploader {
    async fn upload_once(
        &self,
        http: &reqwest::Client,
        limits: &tokio::sync::Semaphore,
        bytes: &[u8],
        content_type: &str,
        size: usize,
    ) -> Result<ProviderMediaReference, UploadFailure> {
        let _permit = limits
            .acquire()
            .await
            .map_err(|_| UploadFailure::Permanent("Media upload unavailable".into()))?;
        let response = http
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .timeout(Duration::from_secs(20))
            .json(&serde_json::json!({"bytes":size,"contentType":content_type}))
            .send()
            .await
            .map_err(|error| {
                classify_network_error("Reference upload ticket request failed", error)
            })?;
        if !response.status().is_success() {
            return Err(classify_status_error(
                "Reference upload unavailable",
                response.status(),
            ));
        }
        if response.content_length().is_some_and(|n| n > 16_384) {
            return Err(UploadFailure::Permanent(
                "Media ticket response too large".into(),
            ));
        }
        let data = response
            .bytes()
            .await
            .map_err(|error| classify_network_error("Media ticket response unavailable", error))?;
        if data.len() > 16_384 {
            return Err(UploadFailure::Permanent(
                "Media ticket response too large".into(),
            ));
        }
        let ticket: Ticket = serde_json::from_slice::<TicketResponse>(&data)
            .map_err(|_| UploadFailure::Permanent("Invalid media ticket".into()))?
            .ticket;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| UploadFailure::Permanent("Invalid system clock".into()))?
            .as_millis() as u64;
        if ticket.expires_at < now + 240_000 || ticket.expires_at > now + 3_600_000 {
            return Err(UploadFailure::Permanent(
                "Media ticket expired or invalid".into(),
            ));
        }
        let put = storage_url(&ticket.put_url).map_err(UploadFailure::Permanent)?;
        storage_url(&ticket.get_url).map_err(UploadFailure::Permanent)?;
        let uploaded = http
            .put(put)
            .header("content-type", content_type)
            .header("content-length", size)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|error| classify_network_error("Reference media upload failed", error))?;
        if !uploaded.status().is_success() {
            return Err(classify_status_error(
                "Reference media upload failed",
                uploaded.status(),
            ));
        }
        // H3 reads asynchronously after submission: do not delete on acceptance.
        Ok(ProviderMediaReference {
            url: ticket.get_url,
            content_type: content_type.into(),
            bytes: size,
            expires_at: ticket.expires_at,
        })
    }
}

fn classify_network_error(prefix: &str, error: reqwest::Error) -> UploadFailure {
    if error.is_timeout() || error.is_connect() || error.is_request() {
        UploadFailure::Retryable(prefix.into())
    } else {
        UploadFailure::Permanent(prefix.into())
    }
}

fn classify_status_error(prefix: &str, status: reqwest::StatusCode) -> UploadFailure {
    let message = format!("{prefix} (HTTP {})", status.as_u16());
    if status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
    {
        UploadFailure::Retryable(message)
    } else {
        UploadFailure::Permanent(message)
    }
}

/// A provider-readable reference returned by the host media uploader.
/// Signed URLs are kept in memory and are never persisted by the tools layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderMediaReference {
    pub url: String,
    pub content_type: String,
    pub bytes: usize,
    pub expires_at: u64,
}

/// Uploads local media to a provider-readable short-lived URL.
#[async_trait]
pub trait ProviderMediaUploader: Send + Sync {
    /// Identifies the credential scope for the in-memory image cache.
    /// Implementations that cannot safely share references should return `None`.
    fn cache_namespace(&self) -> Option<String> {
        None
    }

    async fn upload(
        &self,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<ProviderMediaReference, String>;
}

#[cfg(test)]
mod tests;
