use miniq_protocol::{
    ErrorCode, Event, PluginDiagnosticsResult, PluginIdParams, PluginInstallParams,
    PluginListResult, PluginSetEnabledParams, RpcError,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::state::AppState;

pub fn list(state: &AppState) -> Result<Value, RpcError> {
    let manager = manager(state)?;
    encode(PluginListResult {
        plugins: manager.list(),
    })
}

pub async fn reload(state: &AppState, params: Option<Value>) -> Result<Value, RpcError> {
    let input: PluginIdParams = decode(params)?;
    manager(state)?
        .reload(&input.id)
        .await
        .map_err(plugin_error)?;
    publish(state)
}

pub async fn install(state: &AppState, params: Option<Value>) -> Result<Value, RpcError> {
    let input: PluginInstallParams = decode(params)?;
    manager(state)?
        .install_from_directory(std::path::Path::new(&input.path))
        .await
        .map_err(plugin_error)?;
    publish(state)
}

pub async fn uninstall(state: &AppState, params: Option<Value>) -> Result<Value, RpcError> {
    let input: PluginIdParams = decode(params)?;
    manager(state)?
        .uninstall(&input.id)
        .await
        .map_err(plugin_error)?;
    publish(state)
}

pub async fn set_enabled(state: &AppState, params: Option<Value>) -> Result<Value, RpcError> {
    let input: PluginSetEnabledParams = decode_plugin_enabled(params)?;
    manager(state)?
        .set_enabled(&input.id, input.enabled, input.confirm_trusted_code)
        .await
        .map_err(plugin_error)?;
    publish(state)
}

pub fn diagnostics(state: &AppState, params: Option<Value>) -> Result<Value, RpcError> {
    let input: PluginIdParams = decode(params)?;
    let plugin = manager(state)?
        .diagnostics(&input.id)
        .ok_or_else(|| RpcError::new(ErrorCode::InvalidParams, "plugin not found"))?;
    encode(PluginDiagnosticsResult { plugin })
}

fn publish(state: &AppState) -> Result<Value, RpcError> {
    let plugins = manager(state)?.list();
    state.emit(Event::PluginsChanged {
        plugins: plugins.clone(),
    });
    encode(PluginListResult { plugins })
}

fn manager(state: &AppState) -> Result<&miniq_plugins::PluginManager, RpcError> {
    Ok(&state.plugins)
}

fn decode<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error.to_string()))
}

fn decode_plugin_enabled(params: Option<Value>) -> Result<PluginSetEnabledParams, RpcError> {
    let raw = params.unwrap_or(Value::Null);
    serde_json::from_value(raw.clone()).map_err(|error| {
        let detail = match &raw {
            Value::Object(fields) => fields
                .iter()
                .filter_map(|(name, value)| {
                    if matches!(name.as_str(), "enabled" | "confirmTrustedCode")
                        && !value.is_boolean()
                    {
                        Some(format!("{name} must be boolean, got {}", value_type(value)))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("; "),
            _ => String::new(),
        };
        let message = if detail.is_empty() {
            error.to_string()
        } else {
            detail
        };
        RpcError::new(ErrorCode::InvalidParams, message)
    })
}

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))
}

fn plugin_error(error: miniq_plugins::PluginError) -> RpcError {
    RpcError::new(ErrorCode::InternalError, error.to_string())
}
