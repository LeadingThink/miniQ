//! Daily, per-channel capability discovery for media tools.
//!
//! This module owns only capability metadata. It never serializes credentials,
//! and it does not decide how a media request is sent. The parent media module
//! can use the registry to decorate tool schemas and validate model choices.

use miniq_models::ToolSpec;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use url::Url;

mod fetch;
mod http;
mod model_guidance;
mod provider_document;
mod schema;
mod speech_document;
use fetch::*;
use http::*;
use schema::*;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod schema_tests;

#[cfg(test)]
mod route_tests;

#[cfg(test)]
mod tts_tests;

#[cfg(test)]
mod wire_tests;

pub const MEDIA_REFRESH_INTERVAL_SECS: u64 = 86_400;

const PAGE_SIZE: usize = 100;
const REQUEST_TIMEOUT_SECS: u64 = 12;
const MAX_RETRIES: usize = 2;
const MAX_SCHEMA_DEPTH: usize = 16;
const MAX_SCHEMA_NODES: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaModel {
    pub id: String,
    pub kind: String,
    pub max_duration: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default)]
    pub schemas: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilitySource {
    pub url: String,
    pub fetched_at: u64,
    #[serde(default)]
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilitySnapshot {
    pub base_url: String,
    pub fetched_at: u64,
    pub models: Vec<MediaModel>,
    pub schemas: BTreeMap<String, Value>,
    #[serde(default)]
    pub sources: Vec<MediaCapabilitySource>,
    #[serde(default)]
    pub partial: bool,
}

impl MediaCapabilitySnapshot {
    /// Return a model for a capability kind without silently replacing an
    /// explicit caller choice.
    pub fn select_model(
        &self,
        kind: &str,
        preferred: &str,
        requested: Option<&str>,
    ) -> Result<String, String> {
        let kind = canonical_kind(kind);
        let tool = match kind {
            "image" => "generate_image",
            "video" => "generate_video",
            "music" => "generate_music",
            "tts" => "synthesize_speech",
            _ => "",
        };
        let executable = |model: &MediaModel| {
            !is_dedicated_route(model) && (tool.is_empty() || supports_tool(model, tool))
        };
        if requested.is_some_and(|model| model.trim().is_empty()) {
            return Err("requested media model must not be empty".into());
        }
        let requested = requested.map(str::trim);
        if let Some(requested) = requested {
            let model = self.models.iter().find(|model| model.id == requested);
            return match model {
                Some(model) if (model.kind == kind || model.kind == "unknown") && !is_dedicated_route(model) => {
                    let tool = match kind {"image"=>"generate_image","video"=>"generate_video","music"=>"generate_music","tts"=>"synthesize_speech",_=>""};
                    if !tool.is_empty() && !supports_tool(model,tool) {
                        return Err(format!("requested media model `{requested}` does not support {tool}"));
                    }
                    Ok(model.id.clone())
                }
                Some(model) if is_dedicated_route(model) => Err(format!(
                    "requested media model `{requested}` requires a separate generation endpoint, not supported by this tool"
                )),
                Some(model) => Err(format!(
                    "requested media model `{requested}` has kind `{}`, expected `{kind}`",
                    model.kind
                )),
                None => Err(format!(
                    "requested media model `{requested}` is unavailable"
                )),
            };
        }

        if let Some(model) = self.models.iter().find(|model| {
            (model.kind == kind || model.kind == "unknown")
                && model.id == preferred
                && executable(model)
        }) {
            return Ok(model.id.clone());
        }

        let mut candidates = self
            .models
            .iter()
            .filter(|model| model.kind == kind && executable(model))
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();
        candidates.sort_unstable();
        if kind == "music" {
            if let Some(suno) = candidates.iter().find(|id| **id == "suno-v6") {
                return Ok((*suno).to_owned());
            }
        }
        candidates
            .first()
            .map(|model| (*model).to_owned())
            .ok_or_else(|| format!("no media model is available for kind `{kind}`"))
    }

    /// Find a field schema, preferring metadata discovered for the selected
    /// model over the channel-wide schema.
    pub fn parameter_schema<'a>(
        &'a self,
        tool: &str,
        model: &str,
        field: &str,
    ) -> Option<&'a Value> {
        let model = self.models.iter().find(|candidate| candidate.id == model)?;
        model
            .schemas
            .get(tool)
            .and_then(|schema| schema.get("properties")?.get(field))
            .or_else(|| {
                if tool == "generate_video" && is_h3_model_id(&model.id) {
                    let native = match field {
                        "duration" => "seconds",
                        "aspect_ratio" => "ratio",
                        other => other,
                    };
                    return model
                        .schemas
                        .get("channel_request")?
                        .get("properties")?
                        .get(native);
                }
                self.schemas.get(tool)?.get("properties")?.get(field)
            })
    }

    /// Merge current capability ranges and model enums into tool specs.
    pub fn decorate_specs(&self, specs: &mut [ToolSpec]) {
        for spec in specs {
            let Some(kind) = tool_kind(&spec.name) else {
                continue;
            };
            let Some(discovered) = self.schemas.get(&spec.name) else {
                continue;
            };
            let mut schema = merge_tool_schema(&spec.name, discovered);
            if spec.name == "generate_video" {
                schema = video_catalog_schema(&schema);
            }
            let models = self
                .models
                .iter()
                .filter(|model| model.kind == kind && supports_tool(model, &spec.name))
                .collect::<Vec<_>>();
            let base = schema.clone();
            let mut effective = Vec::new();
            for model in &models {
                let mut model_schema = if spec.name == "generate_video" {
                    video_model_schema(model, Some(discovered))
                } else if spec.name == "synthesize_speech" {
                    schema::speech_model_schema(model, discovered)
                } else {
                    let mut value = base.clone();
                    value.as_object_mut().unwrap().remove("allOf");
                    if let Some(overrides) = model
                        .schemas
                        .get(&spec.name)
                        .and_then(|s| s.get("properties"))
                        .and_then(Value::as_object)
                    {
                        for (field, constraints) in overrides {
                            if let (Some(target), Some(constraints)) = (
                                value["properties"][field].as_object_mut(),
                                constraints.as_object(),
                            ) {
                                target.extend(constraints.clone());
                            }
                        }
                    }
                    value
                };
                if spec.name == "generate_image"
                    && model.id.starts_with("gpt-image-")
                    && Url::parse(&self.base_url)
                        .ok()
                        .is_some_and(|url| url.host_str() == Some("oneapi.zaiwenai.com"))
                {
                    for field in ["size", "quality"] {
                        model_schema["properties"][field] = json!({"type":["string","null"],"description":"Prompt guidance on the Codex route. Not an exact output control."});
                    }
                }
                if schema.get("allOf").is_none() {
                    schema["allOf"] = json!([]);
                }
                schema["allOf"].as_array_mut().unwrap().push(json!({
                    "if":{"required":["model"],"properties":{"model":{"const":model.id}}},
                    "then":{"properties":model_schema["properties"]}
                }));
                effective.push((model.id.as_str(), model_schema));
            }
            model_guidance::widen_envelope(&mut schema, &effective);
            if !models.is_empty() {
                let mut ids = models
                    .iter()
                    .map(|model| model.id.clone())
                    .collect::<Vec<_>>();
                ids.sort();
                if let Some(model_schema) = schema
                    .get_mut("properties")
                    .and_then(Value::as_object_mut)
                    .and_then(|properties| properties.get_mut("model"))
                {
                    let mut choices = ids.into_iter().map(Value::String).collect::<Vec<_>>();
                    choices.push(Value::Null);
                    model_schema["enum"] = Value::Array(choices);
                    let current = model_schema.get("default").and_then(Value::as_str);
                    if current.is_none()
                        || !models
                            .iter()
                            .any(|model| Some(model.id.as_str()) == current)
                    {
                        if let Some(default) = self.default_model(kind, &models) {
                            model_schema["default"] = json!(default);
                        }
                    }
                }
            }
            spec.description.push('\n');
            spec.description
                .push_str(&self.model_guidance(&spec.name, ""));
            spec.parameters = schema;
        }
    }

    fn default_model<'a>(&self, kind: &str, models: &[&'a MediaModel]) -> Option<String> {
        let preferred = match kind {
            "music" => "suno-v6",
            "image" => "gpt-image-2.5-flare",
            "video" => "grok-imagine-video-1.5",
            "tts" => "grok-tts",
            _ => "",
        };
        self.select_model(kind, preferred, None).ok().or_else(|| {
            models
                .iter()
                .filter(|model| !is_dedicated_route(model))
                .map(|model| model.id.clone())
                .min()
        })
    }
}

#[derive(Default)]
struct ChannelState {
    credential_fingerprint: Option<u64>,
    last_attempt: Option<u64>,
    failures: usize,
}

struct Channel {
    state: AsyncMutex<ChannelState>,
    snapshot: Mutex<Option<Arc<MediaCapabilitySnapshot>>>,
}

pub struct MediaCapabilityRegistry {
    cache_directory: Option<PathBuf>,
    channels: Mutex<HashMap<String, Arc<Channel>>>,
}

impl MediaCapabilityRegistry {
    pub fn new(cache_directory: Option<PathBuf>) -> Self {
        let registry = Self {
            cache_directory,
            channels: Mutex::new(HashMap::new()),
        };
        registry.load_cache();
        registry
    }

    pub fn snapshot(&self, base_url: &str) -> Option<Arc<MediaCapabilitySnapshot>> {
        let key = normalize_base_url(base_url).ok()?;
        let channel = self.channel(&key);
        let snapshot = channel.snapshot.lock().ok()?.clone();
        snapshot
    }

    pub async fn refresh_due(
        &self,
        media: &crate::MediaConfig,
    ) -> Result<Arc<MediaCapabilitySnapshot>, String> {
        let base_url = normalize_base_url(&media.base_url)?;
        let channel = self.channel(&base_url);
        let mut state = channel.state.lock().await;
        let now = now_secs();
        let fingerprint = stable_hash(&media.api_key);
        let changed_credentials = state
            .credential_fingerprint
            .is_some_and(|previous| previous != fingerprint);
        if changed_credentials {
            state.failures = 0;
            state.last_attempt = None;
        }
        state.credential_fingerprint = Some(fingerprint);
        if let Some(snapshot) = channel.snapshot.lock().unwrap().clone() {
            if !changed_credentials
                && snapshot.schemas.contains_key("synthesize_speech")
                && now.saturating_sub(snapshot.fetched_at) < MEDIA_REFRESH_INTERVAL_SECS
            {
                return Ok(snapshot);
            }
        }
        if let Some(last_attempt) = state.last_attempt {
            let backoff = retry_backoff(state.failures);
            if now.saturating_sub(last_attempt) < backoff {
                return Err(format!(
                    "capability refresh backoff active for `{base_url}`"
                ));
            }
        }
        state.last_attempt = Some(now);
        match fetch_snapshot(media, &base_url).await {
            Ok(snapshot) => {
                let snapshot = Arc::new(snapshot);
                if let Err(error) = self.persist(&snapshot).await {
                    state.failures = state.failures.saturating_add(1);
                    return Err(format!("persisting capability snapshot failed: {error}"));
                }
                state.failures = 0;
                *channel.snapshot.lock().unwrap() = Some(snapshot.clone());
                Ok(snapshot)
            }
            Err(error) => {
                state.failures = state.failures.saturating_add(1);
                Err(error)
            }
        }
    }

    fn channel(&self, key: &str) -> Arc<Channel> {
        let mut channels = self
            .channels
            .lock()
            .expect("capability channels lock poisoned");
        channels
            .entry(key.to_owned())
            .or_insert_with(|| {
                Arc::new(Channel {
                    state: AsyncMutex::new(ChannelState::default()),
                    snapshot: Mutex::new(None),
                })
            })
            .clone()
    }

    fn load_cache(&self) {
        let Some(directory) = &self.cache_directory else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(snapshot) = serde_json::from_slice::<MediaCapabilitySnapshot>(&bytes) else {
                continue;
            };
            let Ok(key) = normalize_base_url(&snapshot.base_url) else {
                continue;
            };
            let channel = self.channel(&key);
            *channel.snapshot.lock().unwrap() = Some(Arc::new(snapshot));
        }
    }

    async fn persist(&self, snapshot: &MediaCapabilitySnapshot) -> Result<(), String> {
        let Some(directory) = &self.cache_directory else {
            return Ok(());
        };
        tokio::fs::create_dir_all(directory)
            .await
            .map_err(|error| error.to_string())?;
        let name = format!(
            "media-capabilities-{:016x}.json",
            stable_hash(&snapshot.base_url)
        );
        let destination = directory.join(name);
        let temporary = directory.join(format!(
            ".{}.tmp-{}",
            destination.file_name().unwrap().to_string_lossy(),
            std::process::id()
        ));
        let bytes = serde_json::to_vec_pretty(snapshot).map_err(|error| error.to_string())?;
        tokio::fs::write(&temporary, bytes)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::rename(&temporary, &destination)
            .await
            .map_err(|error| error.to_string())
    }
}

fn retry_backoff(failures: usize) -> u64 {
    match failures {
        0 => 0,
        1 => 300,
        2 => 900,
        _ => 3600,
    }
}

fn endpoint_url(base_url: &str, path: &str) -> String {
    let mut url = Url::parse(base_url).expect("normalized media URL");
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}/{path}"));
    url.set_query(None);
    url.to_string()
}

fn root_endpoint_url(base_url: &str, path: &str) -> String {
    let mut url = Url::parse(base_url).expect("normalized media URL");
    url.set_path(&format!("/{path}"));
    url.set_query(None);
    url.to_string()
}

fn normalize_base_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    let url = Url::parse(value).map_err(|_| "media base_url must be an absolute URL".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("media base_url must use http or https".into());
    }
    if url.host_str().is_none() {
        return Err("media base_url must include a host".into());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("media base_url must not include userinfo".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("media base_url must not include query or fragment".into());
    }
    let mut normalized = url;
    let path = normalized.path().trim_end_matches('/').to_owned();
    normalized.set_path(if path.is_empty() { "/" } else { &path });
    Ok(normalized.to_string().trim_end_matches('/').to_owned())
}

fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn is_known_zaiwen_host(base_url: &str) -> Result<bool, String> {
    let host = Url::parse(base_url)
        .map_err(|_| "invalid media URL".to_owned())?
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(host == "zaiwen.top"
        || host.ends_with(".zaiwen.top")
        || host == "zaiwenai.com"
        || host.ends_with(".zaiwenai.com"))
}

fn now_secs() -> u64 {
    #[cfg(test)]
    {
        let value = TEST_NOW.load(std::sync::atomic::Ordering::Relaxed);
        if value != 0 {
            return value;
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
static TEST_NOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
fn set_test_now(value: u64) {
    TEST_NOW.store(value, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().expect("test clock lock poisoned")
}
