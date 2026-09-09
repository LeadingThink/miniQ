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
    #[serde(default)]
    clear_api_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelsParams {
    base_url: String,
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
            .filter(|existing| {
                existing.base_url.trim_end_matches('/')
                    == provider.base_url.trim().trim_end_matches('/')
            })
            .map(|existing| existing.api_key.clone());
        settings.provider = Some(miniq_models::ProviderConfig {
            base_url: provider.base_url.trim().to_string(),
            api_key: if provider.clear_api_key {
                String::new()
            } else {
                merged_key(provider.api_key, existing_key)
            },
            model: provider.model.trim().to_string(),
            api_protocol: provider.api_protocol,
            reasoning_effort: None,
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

pub(super) async fn models(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ModelsParams = params(raw)?;
    let base_url = input.base_url.trim();
    let saved = state.settings.lock().unwrap().provider.clone();
    let api_key = input
        .api_key
        .filter(|key| !key.trim().is_empty())
        .map(|key| key.trim().to_string())
        .or_else(|| {
            saved
                .as_ref()
                .filter(|provider| {
                    provider.base_url.trim_end_matches('/') == base_url.trim_end_matches('/')
                })
                .map(|provider| provider.api_key.clone())
        })
        .unwrap_or_default();
    let config = miniq_models::ProviderConfig {
        base_url: base_url.to_string(),
        api_key,
        model: saved.map(|provider| provider.model).unwrap_or_default(),
        api_protocol: ApiProtocol::Auto,
        reasoning_effort: None,
    };
    super::session_model::catalog_for(&config).await
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
    if provider.clear_api_key
        && provider
            .api_key
            .as_ref()
            .is_some_and(|key| !key.trim().is_empty())
    {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "clearApiKey cannot be combined with a new key",
        ));
    }
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
    fn endpoint_changes_never_reuse_another_endpoints_key_and_logout_clears_it() {
        let state = AppState::new(
            miniq_memory::Store::open_in_memory().unwrap(),
            "fixture".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
        );
        update(&state, Some(json!({"provider":{"baseUrl":"https://one.test/v1","model":"fixture","apiKey":"secret"}}))).unwrap();
        update(
            &state,
            Some(json!({"provider":{"baseUrl":"https://one.test/v1/","model":"new"}})),
        )
        .unwrap();
        assert_eq!(
            state
                .settings
                .lock()
                .unwrap()
                .provider
                .as_ref()
                .unwrap()
                .api_key,
            "secret"
        );
        update(
            &state,
            Some(json!({"provider":{"baseUrl":"https://two.test/v1","model":"fixture"}})),
        )
        .unwrap();
        assert!(state
            .settings
            .lock()
            .unwrap()
            .provider
            .as_ref()
            .unwrap()
            .api_key
            .is_empty());
        update(&state, Some(json!({"provider":{"baseUrl":"https://two.test/v1","model":"fixture","apiKey":"new-secret"}}))).unwrap();
        let result = update(&state, Some(json!({"provider":{"baseUrl":"https://two.test/v1","model":"fixture","clearApiKey":true}}))).unwrap();
        assert_eq!(result["provider"]["hasApiKey"], false);
        assert!(state
            .settings
            .lock()
            .unwrap()
            .provider
            .as_ref()
            .unwrap()
            .api_key
            .is_empty());
        assert!(update(&state, Some(json!({"provider":{"baseUrl":"https://two.test/v1","model":"fixture","apiKey":"conflict","clearApiKey":true}}))).is_err());
    }

    #[test]
    fn provider_validation_requires_an_http_url() {
        for base_url in ["not-a-url", "ftp://models.test/v1"] {
            let result = validate_provider(&ProviderUpdate {
                base_url: base_url.to_string(),
                model: "model".to_string(),
                api_protocol: ApiProtocol::Auto,
                api_key: None,
                clear_api_key: false,
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

    #[tokio::test]
    async fn model_catalog_uses_unsaved_url_and_reuses_its_saved_key() {
        use axum::{routing::get as route, Json, Router};
        let app = Router::new().route(
            "/v1/models",
            route(|headers: axum::http::HeaderMap| async move {
                assert_eq!(headers["authorization"], "Bearer secret");
                Json(json!({"data":[{"id":"zeta"},{"id":"alpha"}]}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = AppState::new(
            miniq_memory::Store::open_in_memory().unwrap(),
            "fixture".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
        );
        state.settings.lock().unwrap().provider = Some(miniq_models::ProviderConfig {
            base_url: format!("http://{address}"),
            api_key: "secret".into(),
            model: "current".into(),
            api_protocol: ApiProtocol::Auto,
            reasoning_effort: None,
        });

        let result = models(
            &state,
            Some(json!({"baseUrl": format!("http://{address}/")})),
        )
        .await
        .unwrap();
        assert_eq!(result["models"], json!(["alpha", "zeta"]));
        assert!(!result.to_string().contains("secret"));
        server.abort();
    }
}
