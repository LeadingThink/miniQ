//! miniq-daemon: local agent daemon exposing a JSON-RPC over WebSocket
//! gateway on 127.0.0.1.

mod agent_progress;
mod agent_task_manager;
mod agent_tasks;
mod agent_worktree;
mod event_journal;
pub mod executor;
pub mod gateway;
pub mod learn;
pub mod mcp;
pub mod remote;
pub mod schedule;
mod security;
pub mod server;
mod session_models;
pub mod state;
pub mod turn;
mod turn_checkpoint;

use miniq_models::{ModelProvider, ProviderConfig};
use rand::distr::Alphanumeric;
use rand::Rng;

/// Load daemon settings: `settings.json` in the data dir wins; environment
/// variables are the fallback for first-run convenience.
pub fn load_settings(settings_path: &std::path::Path) -> state::DaemonSettings {
    let mut settings = state::DaemonSettings::load(settings_path);
    if settings.remote_access.ensure_device_id() {
        if let Err(error) = settings.save(settings_path) {
            tracing::warn!(%error, "failed to persist remote desktop device id");
        }
    }
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

pub use miniq_local::{data_dir, write_connection_info, ConnectionInfo};

pub fn generate_token() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_settings_persists_a_missing_remote_device_id() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"remoteAccess":{"enabled":true,"relayUrl":"wss://relay.test/ws","deviceName":"Desk"}}"#,
        )
        .unwrap();

        let first = load_settings(&path);
        let second = load_settings(&path);

        assert!(first.remote_access.device_id.starts_with("desktop-"));
        assert_eq!(
            first.remote_access.device_id,
            second.remote_access.device_id
        );
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains(&first.remote_access.device_id));
    }
}
