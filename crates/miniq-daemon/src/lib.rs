//! miniq-daemon: local agent daemon exposing a JSON-RPC over WebSocket
//! gateway on 127.0.0.1.

pub mod executor;
pub mod gateway;
pub mod learn;
pub mod mcp;
pub mod remote;
pub mod schedule;
mod security;
pub mod server;
pub mod state;
pub mod turn;

use std::path::PathBuf;

use miniq_models::{ModelProvider, ProviderConfig};
use rand::distr::Alphanumeric;
use rand::Rng;

/// Load daemon settings: `settings.json` in the data dir wins; environment
/// variables are the fallback for first-run convenience.
pub fn load_settings(settings_path: &std::path::Path) -> state::DaemonSettings {
    let mut settings = state::DaemonSettings::load(settings_path);
    if settings.provider.is_none() {
        if let Ok(config) = ProviderConfig::from_env() {
            tracing::info!(model = %config.model, "provider configured from environment");
            settings.provider = Some(config);
        } else {
            tracing::warn!("no model provider configured; set it via settings.update or MINIQ_BASE_URL/MINIQ_MODEL");
        }
    }
    settings
}

/// Provider used when nothing is configured: fails on use, so the daemon
/// still serves health/session APIs.
pub struct UnconfiguredProvider;

#[async_trait::async_trait]
impl ModelProvider for UnconfiguredProvider {
    async fn stream_complete(
        &self,
        _request: miniq_models::CompletionRequest,
    ) -> Result<miniq_models::DeltaStream, miniq_models::ProviderError> {
        Err(miniq_models::ProviderError::Config(
            "no model provider configured; set MINIQ_BASE_URL / MINIQ_MODEL / MINIQ_API_KEY".into(),
        ))
    }

    fn describe(&self) -> String {
        "unconfigured".to_string()
    }
}

/// Connection info written next to the database so the desktop shell can
/// discover a running daemon.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// Data directory for the daemon (db + connection file).
/// Honors `MINIQ_DATA_DIR`, defaults to `<local appdata>/miniq`.
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MINIQ_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.local/share")))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("miniq")
}

pub fn generate_token() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

pub fn write_connection_info(dir: &std::path::Path, info: &ConnectionInfo) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("daemon.json");
    std::fs::write(path, serde_json::to_string_pretty(info)?)?;
    Ok(())
}
