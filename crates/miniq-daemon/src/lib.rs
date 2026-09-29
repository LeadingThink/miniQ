//! miniq-daemon: local agent daemon exposing a JSON-RPC over WebSocket
//! gateway on 127.0.0.1.

mod activity;
mod agent_progress;
mod agent_task_manager;
mod agent_tasks;
mod agent_worktree;
pub mod approval_rules;
pub mod audit;
mod browser_driver;
mod event_journal;
pub mod executor;
mod external_import_jobs;
mod external_scan_jobs;
pub mod features;
pub mod gateway;
pub mod learn;
pub mod mcp;
mod observed_provider;
mod parallel_policy;
pub mod remote;
pub mod remote_policy;
pub mod schedule;
mod security;
pub mod server;
mod session_models;
mod session_titles;
pub mod ssh;
pub mod state;
pub mod turn;
mod turn_checkpoint;
mod turn_clock;
mod turn_summary;

use miniq_models::{ModelProvider, ProviderConfig};
use rand::distr::Alphanumeric;
use rand::Rng;

/// Load daemon settings: `settings.json` in the data dir wins; environment
/// variables are the fallback for first-run convenience.
pub fn load_settings(settings_path: &std::path::Path) -> state::DaemonSettings {
    load_settings_checked(settings_path).0
}

/// Like [`load_settings`], also returning a corrupt-file report. While the
/// original could not be backed up nothing is written back to it.
pub fn load_settings_checked(
    settings_path: &std::path::Path,
) -> (state::DaemonSettings, Option<state::SettingsLoadError>) {
    let (mut settings, failure) = state::DaemonSettings::load_checked(settings_path);
    let may_save = failure
        .as_ref()
        .is_none_or(|failure| failure.backup_path.is_some());
    if settings.remote_access.ensure_device_id() && may_save {
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
    (settings, failure)
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
    fn corrupt_settings_are_backed_up_and_reported_not_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let corrupt = r#"{"remoteAccess": {"enabled": tru"#;
        std::fs::write(&path, corrupt).unwrap();

        let (settings, failure) = load_settings_checked(&path);
        let failure = failure.expect("load error reported");
        assert_eq!(failure.path, path.display().to_string());
        assert!(!failure.error.is_empty());
        let backup = std::path::PathBuf::from(failure.backup_path.clone().unwrap());
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("settings.json.corrupt-"));
        assert_eq!(backup.parent().unwrap(), directory.path().join("backups"));
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), corrupt);

        // A later save keeps the corrupt copy and does not rotate it into `.bak`.
        let state = state::AppState::with_settings(
            miniq_memory::Store::open_in_memory().unwrap(),
            "t".into(),
            settings.clone(),
            path.clone(),
        );
        state.report_settings_load_error(failure);
        state.update_settings(settings).unwrap();
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), corrupt);
        assert!(!state::settings_last_backup(&path).exists());
    }

    #[test]
    fn unbacked_load_failure_blocks_every_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(&path, "garbage").unwrap();
        let state = state::AppState::with_settings(
            miniq_memory::Store::open_in_memory().unwrap(),
            "t".into(),
            state::DaemonSettings::default(),
            path.clone(),
        );
        state.report_settings_load_error(state::SettingsLoadError {
            path: path.display().to_string(),
            error: "boom".into(),
            backup_path: None,
        });
        assert!(state
            .update_settings(state::DaemonSettings::default())
            .is_err());
        assert!(state.restore_settings_backup().is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "garbage");
    }

    #[test]
    fn saves_keep_one_backup_and_restore_swaps_it_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let state = state::AppState::with_settings(
            miniq_memory::Store::open_in_memory().unwrap(),
            "t".into(),
            state::DaemonSettings::default(),
            path.clone(),
        );
        let mut first = state::DaemonSettings::default();
        first.turn_ended_command = Some("one".into());
        state.update_settings(first).unwrap();
        assert!(!state::settings_last_backup(&path).exists());
        let mut second = state::DaemonSettings::default();
        second.turn_ended_command = Some("two".into());
        state.update_settings(second).unwrap();
        let bak = std::fs::read_to_string(state::settings_last_backup(&path)).unwrap();
        assert!(bak.contains("\"one\""));

        state.restore_settings_backup().unwrap();
        assert_eq!(
            state.settings.lock().unwrap().turn_ended_command.as_deref(),
            Some("one")
        );
        let bak = std::fs::read_to_string(state::settings_last_backup(&path)).unwrap();
        assert!(bak.contains("\"two\""));
    }

    #[test]
    fn missing_settings_file_is_not_an_error() {
        let directory = tempfile::tempdir().unwrap();
        let (_, failure) = load_settings_checked(&directory.path().join("settings.json"));
        assert!(failure.is_none());
    }

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
