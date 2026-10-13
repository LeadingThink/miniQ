//! Raw media uses a separate short-lived private object, never RPC ciphertext.
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use miniq_tools::{MediaConfig, ProviderMediaReference, ProviderMediaUploader};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

const ENDPOINT: &str = "https://oneapi.zaiwenai.com/miniq-relay/provider-media/ticket";

pub(crate) fn for_media(
    media: &MediaConfig,
    cancel: CancellationToken,
) -> Option<Arc<dyn ProviderMediaUploader>> {
    // Custom provider credentials must never be sent to the default OneAPI service.
    let url = reqwest::Url::parse(&media.base_url).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("oneapi.zaiwenai.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(Arc::new(HttpUploader {
        key: media.api_key.clone(),
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

fn storage_url(raw: &str) -> Result<reqwest::Url, String> {
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
        tokio::select! {
            _ = self.cancel.cancelled() => Err("Media upload cancelled".into()),
            result = async {
                let _permit = limits.acquire().await.map_err(|_| "Media upload unavailable")?;
                let response = http.post(&self.endpoint).bearer_auth(&self.key)
                    .timeout(Duration::from_secs(20))
                    .json(&serde_json::json!({"bytes":size,"contentType":content_type}))
                    .send().await.map_err(|_| "Reference upload ticket request failed")?;
                if !response.status().is_success() {
                    return Err(format!("Reference upload unavailable (HTTP {})", response.status().as_u16()));
                }
                if response.content_length().is_some_and(|n| n > 16_384) { return Err("Media ticket response too large".into()); }
                let data = response.bytes().await.map_err(|_| "Media ticket response unavailable")?;
                if data.len() > 16_384 { return Err("Media ticket response too large".into()); }
                let ticket: Ticket = serde_json::from_slice::<TicketResponse>(&data).map_err(|_| "Invalid media ticket")?.ticket;
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Invalid system clock")?.as_millis() as u64;
                if ticket.expires_at < now + 240_000 || ticket.expires_at > now + 3_600_000 { return Err("Media ticket expired or invalid".into()); }
                let put = storage_url(&ticket.put_url)?;
                storage_url(&ticket.get_url)?;
                let uploaded = http.put(put).header("content-type", content_type)
                    .header("content-length", size).body(bytes).send().await.map_err(|_| "Reference media upload failed")?;
                if !uploaded.status().is_success() { return Err(format!("Reference media upload failed (HTTP {})", uploaded.status().as_u16())); }
                // H3 reads asynchronously after submission: do not delete on acceptance.
                Ok(ProviderMediaReference { url: ticket.get_url, content_type: content_type.into(), bytes: size })
            } => result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_provider_credentials_are_not_forwarded() {
        for base in [
            "https://example.com/v1",
            "http://oneapi.zaiwenai.com/v1",
            "https://oneapi.zaiwenai.com.evil.test/v1",
            "https://user@oneapi.zaiwenai.com/v1",
        ] {
            let media = MediaConfig {
                base_url: base.into(),
                ..Default::default()
            };
            assert!(for_media(&media, CancellationToken::new()).is_none());
        }
        assert!(for_media(
            &MediaConfig {
                base_url: "https://oneapi.zaiwenai.com/v1".into(),
                ..Default::default()
            },
            CancellationToken::new()
        )
        .is_some());
    }
    #[test]
    fn signed_storage_redirect_targets_are_restricted() {
        for bad in [
            "https://evil.test/file",
            "https://127.0.0.1/file",
            "http://s3-cn-south-1.qiniucs.com/file",
            "https://qiniucs.com.evil.test/file",
        ] {
            assert!(storage_url(bad).is_err());
        }
        assert!(storage_url(
            "https://s3-cn-south-1.qiniucs.com/bucket/provider-media/fixture?signature=fixture"
        )
        .is_ok());
    }
}
