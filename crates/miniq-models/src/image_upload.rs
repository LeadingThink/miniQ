//! Replace provider image payloads with private, short-lived media references.
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{ProviderError, ProviderMediaUploader};

const CACHE_REFRESH_MARGIN_MS: u64 = 60_000;
/// Uploads are independent network round trips, so several run at once instead
/// of making every image wait for the previous one.
const MAX_PARALLEL_UPLOADS: usize = 4;

#[derive(Clone, Debug)]
struct CachedReference {
    url: String,
    content_type: String,
    bytes: usize,
    expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct UploadKey {
    namespace: Option<String>,
    mime: String,
    digest: [u8; 32],
}

static SHARED_UPLOADS: OnceLock<Mutex<HashMap<UploadKey, CachedReference>>> = OnceLock::new();

#[derive(Default)]
pub(crate) struct ImageUploads {
    // Rebuilds for attachment recovery or request budgets reuse completed uploads.
    urls: HashMap<UploadKey, CachedReference>,
    // Key for every image payload in document order, so the rewrite pass never
    // decodes the same base64 payload twice.
    plan: VecDeque<UploadKey>,
}

impl ImageUploads {
    /// Replace provider image payloads with private, short-lived media
    /// references. Uploads run first and concurrently; the rewrite itself stays
    /// synchronous, so a failed upload leaves the request body untouched.
    pub(crate) async fn replace(
        &mut self,
        body: &mut Value,
        uploader: &dyn ProviderMediaUploader,
    ) -> Result<(), ProviderError> {
        self.prefetch(body, uploader).await?;
        let urls = &self.urls;
        let plan = &mut self.plan;
        visit_images(body, &mut |target, anthropic| {
            let Some(reference) = plan.pop_front().and_then(|key| urls.get(&key)).cloned() else {
                return Err(ProviderError::Config(
                    "image upload was not prepared".into(),
                ));
            };
            *target = if anthropic {
                json!({"type":"url", "url":reference.url})
            } else {
                json!(reference.url)
            };
            Ok(())
        })
    }

    async fn prefetch(
        &mut self,
        body: &mut Value,
        uploader: &dyn ProviderMediaUploader,
    ) -> Result<(), ProviderError> {
        let namespace = uploader.cache_namespace();
        let mut plan = VecDeque::new();
        let mut jobs: HashMap<UploadKey, (String, Vec<u8>)> = HashMap::new();
        visit_images(body, &mut |target, anthropic| {
            let (mime, encoded) = image_payload(target, anthropic)?;
            let (mime, bytes) = upload_payload(mime, encoded)?;
            let key = UploadKey {
                namespace: namespace.clone(),
                mime: mime.clone(),
                digest: Sha256::digest(&bytes).into(),
            };
            plan.push_back(key.clone());
            jobs.entry(key).or_insert((mime, bytes));
            Ok(())
        })?;
        self.plan = plan;

        let mut pending = Vec::new();
        for (key, (mime, bytes)) in jobs {
            if self
                .urls
                .get(&key)
                .is_some_and(|reference| usable(reference, &mime, bytes.len()))
            {
                continue;
            }
            if let Some(shared) = key
                .namespace
                .as_ref()
                .and_then(|_| shared_get(&key))
                .filter(|reference| usable(reference, &mime, bytes.len()))
            {
                self.urls.insert(key, shared);
                continue;
            }
            pending.push((key, mime, bytes));
        }
        let uploaded = stream::iter(pending)
            .map(|(key, mime, bytes)| async move {
                let size = bytes.len();
                let outcome = uploader.upload(bytes, &mime).await;
                (key, mime, size, outcome)
            })
            .buffer_unordered(MAX_PARALLEL_UPLOADS)
            .collect::<Vec<_>>()
            .await;
        for (key, mime, size, outcome) in uploaded {
            let reference = outcome.map_err(|error| {
                ProviderError::Config(format!(
                    "图片上传七牛云失败：{error}。未向模型发送请求，请重试。"
                ))
            })?;
            crate::media_upload::storage_url(&reference.url).map_err(ProviderError::Config)?;
            if reference.content_type != mime || reference.bytes != size {
                return Err(ProviderError::Config(
                    "Invalid uploaded image metadata".into(),
                ));
            }
            let reference = CachedReference {
                url: reference.url,
                content_type: reference.content_type,
                bytes: reference.bytes,
                expires_at: reference.expires_at,
            };
            self.urls.insert(key.clone(), reference.clone());
            if key.namespace.is_some() && is_fresh(reference.expires_at) {
                shared_insert(key, reference);
            }
        }
        Ok(())
    }
}

/// Visits every image payload under `messages` / `input` in document order.
/// Assistant turns are skipped: their content is signed context and must never
/// be rewritten.
fn visit_images(
    body: &mut Value,
    visit: &mut impl FnMut(&mut Value, bool) -> Result<(), ProviderError>,
) -> Result<(), ProviderError> {
    for field in ["messages", "input"] {
        let Some(items) = body.get_mut(field).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items.iter_mut() {
            if item["role"] == "assistant" {
                continue;
            }
            for field in ["content", "output"] {
                if let Some(content) = item.get_mut(field) {
                    visit_content(content, visit)?;
                }
            }
        }
    }
    Ok(())
}

fn visit_content(
    content: &mut Value,
    visit: &mut impl FnMut(&mut Value, bool) -> Result<(), ProviderError>,
) -> Result<(), ProviderError> {
    // Only protocol content is visited. Tool schemas, arguments, signed
    // assistant context and user text are never interpreted as upload requests.
    let mut pending = vec![content];
    while let Some(part) = pending.pop() {
        if let Value::Array(parts) = part {
            pending.extend(parts.iter_mut().rev());
            continue;
        }
        let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
        let anthropic = kind == "image";
        let target = match kind {
            "image_url" => part.pointer_mut("/image_url/url"),
            "input_image" | "computer_screenshot" => part.get_mut("image_url"),
            "image" if part["source"]["type"] == "base64" => part.get_mut("source"),
            "tool_result" => {
                if let Some(content) = part.get_mut("content") {
                    pending.push(content);
                }
                continue;
            }
            _ => None,
        };
        if let Some(target) = target {
            // Already-uploaded references and remote URLs are left alone, so a
            // rebuilt request never re-encodes or re-uploads a finished one.
            if has_payload(target, anthropic) {
                visit(target, anthropic)?;
            }
        }
    }
    Ok(())
}

fn has_payload(target: &Value, anthropic: bool) -> bool {
    if anthropic {
        target["media_type"].is_string() && target["data"].is_string()
    } else {
        target.as_str().is_some_and(|url| {
            url.strip_prefix("data:")
                .is_some_and(|rest| rest.contains(";base64,"))
        })
    }
}

fn image_payload(target: &Value, anthropic: bool) -> Result<(&str, &str), ProviderError> {
    let payload = if anthropic {
        target["media_type"].as_str().zip(target["data"].as_str())
    } else {
        target
            .as_str()
            .and_then(|url| url.strip_prefix("data:"))
            .and_then(|rest| rest.split_once(";base64,"))
    };
    payload.ok_or_else(|| ProviderError::Config("Invalid image upload payload".into()))
}

fn shared_get(key: &UploadKey) -> Option<CachedReference> {
    let cache = SHARED_UPLOADS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache.lock().ok()?;
    let reference = cache.get(key).cloned()?;
    if is_fresh(reference.expires_at) {
        Some(reference)
    } else {
        cache.remove(key);
        None
    }
}

fn shared_insert(key: UploadKey, reference: CachedReference) {
    if let Ok(mut cache) = SHARED_UPLOADS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(key, reference);
    }
}

fn is_fresh(expires_at: u64) -> bool {
    expires_at == u64::MAX || expires_at > now_millis().saturating_add(CACHE_REFRESH_MARGIN_MS)
}

fn usable(reference: &CachedReference, mime: &str, size: usize) -> bool {
    is_fresh(reference.expires_at) && reference.content_type == mime && reference.bytes == size
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn upload_payload(mime: &str, encoded: &str) -> Result<(String, Vec<u8>), ProviderError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ProviderError::Config("Invalid image upload encoding".into()))?;
    if mime != "image/gif" {
        return Ok((mime.to_owned(), bytes));
    }
    // The shared video-reference endpoint accepts PNG/JPEG/WebP. Preserve
    // static GIF pixels as PNG, rejecting animation instead of dropping frames.
    let pixels = crate::decode_static_image(&bytes)?;
    let mut png = std::io::Cursor::new(Vec::new());
    pixels
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| ProviderError::Config("Cannot prepare GIF for image upload".into()))?;
    Ok(("image/png".into(), png.into_inner()))
}

#[cfg(test)]
mod tests;
