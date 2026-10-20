//! Replace provider image payloads with private, short-lived media references.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{ProviderError, ProviderMediaUploader};

const CACHE_REFRESH_MARGIN_MS: u64 = 60_000;

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
}

impl ImageUploads {
    pub(crate) async fn replace(
        &mut self,
        body: &mut Value,
        uploader: &dyn ProviderMediaUploader,
    ) -> Result<(), ProviderError> {
        // Visit only protocol content. Tool schemas, arguments, signed assistant
        // context and user text must never be interpreted as upload requests.
        for field in ["messages", "input"] {
            if let Some(items) = body.get_mut(field).and_then(Value::as_array_mut) {
                for item in items {
                    if item["role"] == "assistant" {
                        continue;
                    }
                    for field in ["content", "output"] {
                        if let Some(content) = item.get_mut(field) {
                            self.replace_content(content, uploader).await?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn replace_content(
        &mut self,
        content: &mut Value,
        uploader: &dyn ProviderMediaUploader,
    ) -> Result<(), ProviderError> {
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
            let Some(target) = target else { continue };
            let (mime, encoded) = if anthropic {
                (target["media_type"].as_str(), target["data"].as_str())
            } else {
                let Some((mime, encoded)) = target
                    .as_str()
                    .and_then(|s| s.strip_prefix("data:"))
                    .and_then(|s| s.split_once(";base64,"))
                else {
                    continue;
                };
                (Some(mime), Some(encoded))
            };
            let (Some(mime), Some(encoded)) = (mime, encoded) else {
                return Err(ProviderError::Config("Invalid image upload payload".into()));
            };
            let (mime, bytes) = upload_payload(mime, encoded)?;
            let key = UploadKey {
                namespace: uploader.cache_namespace(),
                mime: mime.clone(),
                digest: Sha256::digest(&bytes).into(),
            };
            let cached = self
                .urls
                .get(&key)
                .filter(|reference| {
                    is_fresh(reference.expires_at)
                        && reference.content_type == mime
                        && reference.bytes == bytes.len()
                })
                .cloned()
                .or_else(|| {
                    self.urls.remove(&key);
                    key.namespace.as_ref().and_then(|_| shared_get(&key))
                });
            let reference = if let Some(reference) = cached {
                reference
            } else {
                let size = bytes.len();
                let reference = uploader.upload(bytes, &mime).await.map_err(|_| {
                    ProviderError::Config("图片上传七牛云失败，未向模型发送请求，请重试。".into())
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
                    shared_insert(key.clone(), reference.clone());
                }
                reference
            };
            *target = if anthropic {
                json!({"type":"url", "url":reference.url})
            } else {
                json!(reference.url)
            };
        }
        Ok(())
    }
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
