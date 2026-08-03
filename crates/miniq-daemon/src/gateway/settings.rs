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
            "hasApiKey": !provider.api_key.is_empty(),
        })
    });
    Ok(json!({
        "provider": provider,
        "approvalMode": settings.approval_mode,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateParams {
    #[serde(default)]
    provider: Option<ProviderUpdate>,
    #[serde(default)]
    approval_mode: Option<ApprovalMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUpdate {
    base_url: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
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
            base_url: provider.base_url,
            api_key: merged_key(provider.api_key, existing_key),
            model: provider.model,
        });
    }
    if let Some(mode) = input.approval_mode {
        settings.approval_mode = mode;
    }

    state
        .update_settings(settings)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error))?;
    get(state)
}

fn validate_provider(provider: &ProviderUpdate) -> Result<(), RpcError> {
    if provider.base_url.trim().is_empty() || provider.model.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "provider baseUrl and model must not be empty",
        ));
    }
    Ok(())
}

fn merged_key(new_key: Option<String>, existing: Option<String>) -> String {
    match new_key {
        Some(key) if !key.is_empty() => key,
        _ => existing.unwrap_or_default(),
    }
}
