use miniq_models::{ConfiguredProvider, ModelProvider};
use miniq_protocol::{ApiProtocol, ErrorCode, Event, RpcError, SessionModelUpdate};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

const MODEL_CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

pub(super) fn get(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionParams = params(raw)?;
    let settings = state
        .store
        .session_model_settings(&input.session_id)
        .map_err(store_err)?;
    let effective = state
        .provider_config_for_session(&input.session_id, None)
        .map_err(store_err)?;
    to_value(
        json!({ "settings": settings, "effective": effective.map(|config| json!({
        "model": config.model, "apiProtocol": config.api_protocol, "reasoningEffort": config.reasoning_effort,
    })) }),
    )
}

pub(super) async fn update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let mut input: SessionModelUpdate = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    if let Some(model) = &mut input.settings.model {
        *model = model.trim().to_string();
        if model.is_empty() || model.chars().any(char::is_control) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "model must be a nonempty model ID",
            ));
        }
    }
    let baseline = state.settings.lock().unwrap().provider.clone();
    if let Some(effort) = input.settings.reasoning_effort {
        let mut config = baseline.clone().ok_or_else(|| {
            RpcError::new(ErrorCode::InvalidParams, "configure a model provider first")
        })?;
        crate::session_models::apply_selection(&mut config, &input.settings);
        let provider = ConfiguredProvider::new(config.clone());
        let protocol = provider.protocol().await.map_err(provider_err)?;
        let choices = provider
            .capabilities()
            .await
            .reasoning_efforts
            .unwrap_or_else(|| miniq_models::reasoning_efforts(&config.model, protocol));
        if !choices.contains(&effort) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "this model does not advertise the requested reasoning effort",
            ));
        }
    }
    // The same lock guards begin_turn, so configuration and a new turn cannot
    // race between validation of the idle state and persistence.
    let active = state.active_turns.lock().unwrap();
    if active.contains_key(&input.session_id) {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "wait for the current turn to finish before changing its model",
        ));
    }
    if state.settings.lock().unwrap().provider != baseline {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "provider settings changed; reload and retry",
        ));
    }
    state
        .store
        .set_session_model_settings(&input.session_id, &input.settings)
        .map_err(store_err)?;
    drop(active);
    state.emit(Event::ModelSettingsChanged {
        session_id: input.session_id.clone(),
        settings: input.settings,
    });
    get(state, Some(json!({ "sessionId": input.session_id })))
}

pub(super) async fn catalog(state: &AppState) -> Result<Value, RpcError> {
    let config = state
        .settings
        .lock()
        .unwrap()
        .provider
        .clone()
        .ok_or_else(|| {
            RpcError::new(ErrorCode::InvalidParams, "configure a model provider first")
        })?;
    catalog_for(&config).await
}

pub(super) async fn catalog_for(config: &miniq_models::ProviderConfig) -> Result<Value, RpcError> {
    let client = reqwest::Client::builder()
        .timeout(MODEL_CATALOG_TIMEOUT)
        .build()
        .map_err(http_err)?;
    let url = model_catalog_url(&config.base_url)?;
    let mut request = client.get(url);
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }
    let response = request.send().await.map_err(http_err)?;
    if !response.status().is_success() {
        return Err(RpcError::new(
            ErrorCode::ProviderError,
            format!("model catalog returned HTTP {}", response.status().as_u16()),
        ));
    }
    let payload: Value = response.json().await.map_err(http_err)?;
    if payload.get("has_more").and_then(Value::as_bool) == Some(true) {
        return Err(RpcError::new(ErrorCode::ProviderError, "this endpoint returned a partial model catalog; enter the exact model ID or use an unpaginated OneAPI catalog"));
    }
    let rows = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            RpcError::new(
                ErrorCode::ProviderError,
                "model catalog is missing its data array",
            )
        })?;
    let mut models = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    models.sort_by_cached_key(|id| (id.to_lowercase(), id.clone()));
    models.dedup();
    to_value(json!({ "models": models, "defaultModel": config.model }))
}

fn model_catalog_url(base_url: &str) -> Result<url::Url, RpcError> {
    let mut url = url::Url::parse(base_url.trim())
        .map_err(|_| RpcError::new(ErrorCode::InvalidParams, "provider baseUrl is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "provider baseUrl must use http or https",
        ));
    }
    let path = url.path().trim_end_matches('/');
    let catalog_path = if path.is_empty() {
        "/v1/models".to_string()
    } else {
        format!("{path}/models")
    };
    url.set_path(&catalog_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DescribeParams {
    model: String,
    #[serde(default)]
    api_protocol: ApiProtocol,
}

pub(super) async fn describe(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DescribeParams = params(raw)?;
    let mut config = state
        .settings
        .lock()
        .unwrap()
        .provider
        .clone()
        .ok_or_else(|| {
            RpcError::new(ErrorCode::InvalidParams, "configure a model provider first")
        })?;
    config.model = input.model;
    config.api_protocol = input.api_protocol;
    config.reasoning_effort = None;
    let provider = ConfiguredProvider::new(config.clone());
    let protocol = provider.protocol().await.map_err(provider_err)?;
    let capabilities = provider.capabilities().await;
    let efforts = capabilities
        .reasoning_efforts
        .unwrap_or_else(|| miniq_models::reasoning_efforts(&config.model, protocol));
    to_value(json!({ "model": config.model, "apiProtocol": protocol,
        "reasoningEfforts": efforts, "maxContextTokens": capabilities.max_context_tokens,
        "maxOutputTokens": capabilities.max_output_tokens }))
}

fn http_err(_: reqwest::Error) -> RpcError {
    RpcError::new(
        ErrorCode::ProviderError,
        "could not read the model catalog; check the endpoint and connection",
    )
}

fn provider_err(error: miniq_models::ProviderError) -> RpcError {
    RpcError::new(ErrorCode::ProviderError, error.to_string())
}

#[cfg(test)]
mod tests;
