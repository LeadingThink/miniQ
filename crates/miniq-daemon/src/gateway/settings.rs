use miniq_models::ApiProtocol;
use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::params;
use crate::state::{AppState, ApprovalMode};

/// Return UI-safe settings without exposing an API key.
pub(super) fn get(state: &AppState) -> Result<Value, RpcError> {
    let settings = state.settings.lock().unwrap().clone();
    let provider = settings.provider.as_ref().map(|provider| {
        json!({
            "baseUrl": provider.base_url,
            "model": provider.model,
            "apiProtocol": provider.api_protocol,
            "hasApiKey": !provider.api_key.is_empty(),
        })
    });
    Ok(json!({
        "provider": provider,
        "approvalMode": settings.approval_mode,
        "remoteAccess": settings.remote_access,
        "remoteStatus": crate::remote::status(state),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateParams {
    #[serde(default)]
    provider: Option<ProviderUpdate>,
    #[serde(default)]
    approval_mode: Option<ApprovalMode>,
    #[serde(default)]
    remote_access: Option<RemoteAccessUpdate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUpdate {
    base_url: String,
    model: String,
    #[serde(default)]
    api_protocol: ApiProtocol,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAccessUpdate {
    enabled: bool,
    relay_url: String,
    device_name: String,
}

pub(super) fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: UpdateParams = params(raw)?;
    let mut settings = state.settings.lock().unwrap().clone();

    if let Some(provider) = input.provider {
        validate_provider(&provider)?;
        let existing_key = settings
            .provider
            .as_ref()
            .map(|existing| existing.api_key.clone());
        settings.provider = Some(miniq_models::ProviderConfig {
            base_url: provider.base_url.trim().to_string(),
            api_key: merged_key(provider.api_key, existing_key),
            model: provider.model.trim().to_string(),
            api_protocol: provider.api_protocol,
        });
    }
    if let Some(mode) = input.approval_mode {
        settings.approval_mode = mode;
    }
    if let Some(remote) = input.remote_access {
        validate_remote(&remote)?;
        let device_id = settings.remote_access.device_id.clone();
        settings.remote_access = crate::remote::RemoteAccessSettings {
            enabled: remote.enabled,
            relay_url: remote.relay_url.trim().to_string(),
            device_name: remote.device_name.trim().to_string(),
            device_id,
        };
    }

    state
        .update_settings(settings)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error))?;
    get(state)
}

fn validate_remote(remote: &RemoteAccessUpdate) -> Result<(), RpcError> {
    if remote.device_name.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "remote deviceName must not be empty",
        ));
    }
    if remote.device_name.trim().chars().count() > 80 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "remote deviceName must not exceed 80 characters",
        ));
    }
    let url = url::Url::parse(remote.relay_url.trim())
        .map_err(|_| RpcError::new(ErrorCode::InvalidParams, "remote relayUrl is invalid"))?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "remote relayUrl must use ws or wss",
        ));
    }
    Ok(())
}

fn validate_provider(provider: &ProviderUpdate) -> Result<(), RpcError> {
    if provider.base_url.trim().is_empty() || provider.model.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "provider baseUrl and model must not be empty",
        ));
    }
    let url = url::Url::parse(provider.base_url.trim())
        .map_err(|_| RpcError::new(ErrorCode::InvalidParams, "provider baseUrl is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "provider baseUrl must use http or https",
        ));
    }
    Ok(())
}

fn merged_key(new_key: Option<String>, existing: Option<String>) -> String {
    match new_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => existing.unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_validation_requires_an_http_url() {
        for base_url in ["not-a-url", "ftp://models.test/v1"] {
            let result = validate_provider(&ProviderUpdate {
                base_url: base_url.to_string(),
                model: "model".to_string(),
                api_protocol: ApiProtocol::Auto,
                api_key: None,
            });
            assert!(result.is_err(), "{base_url} should be rejected");
        }
    }

    #[test]
    fn remote_validation_enforces_the_relay_name_limit() {
        let result = validate_remote(&RemoteAccessUpdate {
            enabled: true,
            relay_url: "wss://relay.test/ws".to_string(),
            device_name: "x".repeat(81),
        });
        assert!(result.is_err());
    }

    #[test]
    fn api_keys_are_trimmed_without_erasing_the_saved_key() {
        assert_eq!(
            merged_key(Some("  new-key  ".to_string()), Some("old-key".to_string())),
            "new-key"
        );
        assert_eq!(
            merged_key(Some("  ".to_string()), Some("old-key".to_string())),
            "old-key"
        );
    }
}
