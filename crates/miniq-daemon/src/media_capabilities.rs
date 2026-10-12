//! Cached media discovery and the daemon-owned daily refresh worker.

use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use miniq_models::ProviderConfig;
use miniq_protocol::{ErrorCode, RpcError};
use miniq_tools::MediaConfig;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

const CHECK_INTERVAL: Duration = Duration::from_secs(60);

impl AppState {
    /// Use the already resolved session provider for both parent and child tools.
    /// Discovery never changes the paid generation defaults.
    pub fn media_config_for(&self, provider: &ProviderConfig) -> MediaConfig {
        MediaConfig {
            base_url: provider.base_url.clone(),
            api_key: provider.api_key.clone(),
            image_model: "gpt-image-2.5-flare".into(),
            video_model: "grok-imagine-video-1.5".into(),
            tts_model: "grok-tts".into(),
            transcription_model: "grok-transcribe".into(),
            music_model: "suno-v6".into(),
            capabilities: Some(self.media_capabilities.clone()),
        }
    }
}

/// Startup and minute checks delegate the 24-hour TTL and failure backoff to
/// the registry. Fresh checks do not issue HTTP requests.
pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    let registry = state.media_capabilities.clone();
    tokio::spawn(run(state, CHECK_INTERVAL, move |media| {
        let registry = registry.clone();
        async move { registry.refresh_due(&media).await.map(|_| ()) }
    }))
}

async fn run<F, R>(state: AppState, interval: Duration, mut refresh: F)
where
    F: FnMut(MediaConfig) -> R,
    R: Future<Output = Result<(), String>>,
{
    let mut checks = tokio::time::interval(interval);
    checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = state.shutdown.cancelled() => return,
            _ = state.media_settings_changed.notified() => {},
            _ = checks.tick() => {},
        }
        let config = state.settings.lock().unwrap().provider.clone();
        let Some(provider) = config else { continue };
        if provider.api_key.trim().is_empty() {
            continue;
        }
        let channel = channel_key(&provider.base_url);
        let media = state.media_config_for(&provider);
        let result = tokio::select! {
            biased;
            _ = state.shutdown.cancelled() => return,
            result = refresh(media) => result,
        };
        let mut errors = state.media_refresh_errors.lock().unwrap();
        match result {
            Ok(()) => {
                errors.remove(&channel);
            }
            Err(error) => {
                // Provider errors can quote response bodies; never retain credentials.
                let error = error.replace(&provider.api_key, "[redacted]");
                errors.insert(channel, error);
            }
        }
    }
}

/// Use the registry's canonical URL identity for daemon-owned errors too.
fn channel_key(base_url: &str) -> String {
    let base_url = base_url.trim();
    url::Url::parse(base_url)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| base_url.to_owned())
        .trim_end_matches('/')
        .to_owned()
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityParams {
    session_id: Option<String>,
}

/// Read only the configured channel's cached snapshot. RPC callers cannot
/// supply endpoints, credentials, or force requests to a different service.
pub(crate) fn capabilities(state: &AppState, params: Option<Value>) -> Result<Value, RpcError> {
    let params: CapabilityParams = serde_json::from_value(
        params
            .filter(|params| !params.is_null())
            .unwrap_or_else(|| json!({})),
    )
    .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error.to_string()))?;
    let provider = match params.session_id {
        Some(session_id) => state
            .provider_config_for_session(&session_id, None)
            .map_err(|error| RpcError::new(ErrorCode::SessionNotFound, error.to_string()))?,
        None => state.settings.lock().unwrap().provider.clone(),
    };
    let Some(provider) = provider.filter(|provider| !provider.api_key.trim().is_empty()) else {
        return Ok(json!({
            "configured": false,
            "freshness": "unconfigured",
            "fetchedAt": null,
            "snapshot": null,
            "lastError": null,
            "refreshIntervalSecs": miniq_tools::MEDIA_REFRESH_INTERVAL_SECS,
        }));
    };
    let snapshot = state.media_capabilities.snapshot(&provider.base_url);
    let fetched_at = snapshot.as_ref().map(|snapshot| snapshot.fetched_at);
    let snapshot = snapshot
        .map(|snapshot| serde_json::to_value(snapshot.as_ref()))
        .transpose()
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let freshness = match fetched_at {
        Some(fetched_at)
            if now.saturating_sub(fetched_at) < miniq_tools::MEDIA_REFRESH_INTERVAL_SECS =>
        {
            "fresh"
        }
        Some(_) => "stale",
        None => "missing",
    };
    let last_error = state
        .media_refresh_errors
        .lock()
        .unwrap()
        .get(&channel_key(&provider.base_url))
        .cloned();
    Ok(json!({
        "configured": true,
        "freshness": freshness,
        "fetchedAt": fetched_at,
        "snapshot": snapshot,
        "lastError": last_error,
        "refreshIntervalSecs": miniq_tools::MEDIA_REFRESH_INTERVAL_SECS,
    }))
}

#[cfg(test)]
#[path = "media_capabilities_tests.rs"]
mod tests;
