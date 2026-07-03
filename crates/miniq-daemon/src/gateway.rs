//! JSON-RPC method dispatch.
//!
//! Every request coming over the WebSocket is routed through [`dispatch`].
//! Handlers are small and only talk to services (store for now); they never
//! run tools or shell commands directly.

use miniq_protocol::{ErrorCode, HealthStatus, RpcError, RpcRequest, RpcResponse, PROTOCOL_VERSION};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

pub async fn dispatch(state: &AppState, req: RpcRequest) -> RpcResponse {
    let id = req.id.clone();
    let result = match req.method.as_str() {
        "daemon.health" => health(state),
        "workspace.open" => workspace_open(state, req.params),
        "workspace.list" => workspace_list(state),
        "session.create" => session_create(state, req.params),
        "session.list" => session_list(state, req.params),
        "session.open" => session_open(state, req.params),
        "session.sendMessage" => session_send_message(state, req.params),
        "session.cancel" => session_cancel(state, req.params),
        "approval.resolve" => approval_resolve(state, req.params),
        "tool.list" => tool_list(state),
        "settings.get" => settings_get(state),
        "settings.update" => settings_update(state, req.params),
        _ => Err(RpcError::new(
            ErrorCode::MethodNotFound,
            format!("unknown method: {}", req.method),
        )),
    };
    match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err(err) => RpcResponse::err(id, err),
    }
}

fn params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    let value = params.unwrap_or(Value::Null);
    serde_json::from_value(value)
        .map_err(|e| RpcError::new(ErrorCode::InvalidParams, format!("invalid params: {e}")))
}

fn store_err(e: miniq_memory::MemoryError) -> RpcError {
    match &e {
        miniq_memory::MemoryError::NotFound(what) if what.starts_with("session") => {
            RpcError::new(ErrorCode::SessionNotFound, e.to_string())
        }
        miniq_memory::MemoryError::NotFound(what) if what.starts_with("workspace") => {
            RpcError::new(ErrorCode::WorkspaceNotFound, e.to_string())
        }
        _ => RpcError::new(ErrorCode::InternalError, e.to_string()),
    }
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| RpcError::new(ErrorCode::InternalError, e.to_string()))
}

fn health(state: &AppState) -> Result<Value, RpcError> {
    to_value(HealthStatus {
        protocol_version: PROTOCOL_VERSION,
        daemon_version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_secs: state.started.elapsed().as_secs(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceOpenParams {
    path: String,
    #[serde(default)]
    name: Option<String>,
}

fn workspace_open(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: WorkspaceOpenParams = params(raw)?;
    let path = std::path::Path::new(&p.path);
    if !path.is_dir() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("workspace path is not a directory: {}", p.path),
        ));
    }
    let name = p.name.unwrap_or_else(|| {
        path.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| p.path.clone())
    });
    // Normalize to an absolute path with forward slashes so the same
    // directory always maps to the same workspace row.
    let canonical = dunce_canonicalize(path).unwrap_or_else(|| p.path.clone());
    let ws = state
        .store
        .create_workspace(&canonical, &name)
        .map_err(store_err)?;
    to_value(ws)
}

/// Canonicalize without Windows `\\?\` prefix noise.
fn dunce_canonicalize(path: &std::path::Path) -> Option<String> {
    let canon = path.canonicalize().ok()?;
    let s = canon.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    Some(s.replace('\\', "/"))
}

fn workspace_list(state: &AppState) -> Result<Value, RpcError> {
    let list = state.store.list_workspaces().map_err(store_err)?;
    to_value(json!({ "workspaces": list }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreateParams {
    workspace_id: String,
    #[serde(default)]
    title: Option<String>,
}

fn session_create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SessionCreateParams = params(raw)?;
    // Ensure the workspace exists first.
    state.store.get_workspace(&p.workspace_id).map_err(store_err)?;
    let title = p.title.unwrap_or_else(|| "New session".to_string());
    let session = state
        .store
        .create_session(&p.workspace_id, &title)
        .map_err(store_err)?;
    to_value(session)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListParams {
    #[serde(default)]
    workspace_id: Option<String>,
}

fn session_list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SessionListParams = params(raw)?;
    let sessions = state
        .store
        .list_sessions(p.workspace_id.as_deref())
        .map_err(store_err)?;
    to_value(json!({ "sessions": sessions }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageParams {
    session_id: String,
    message: IncomingMessage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingMessage {
    role: String,
    content: String,
}

fn session_send_message(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SendMessageParams = params(raw)?;
    if p.message.role != "user" {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "only user messages can be sent",
        ));
    }
    if p.message.content.trim().is_empty() {
        return Err(RpcError::new(ErrorCode::InvalidParams, "message content is empty"));
    }
    state.store.get_session(&p.session_id).map_err(store_err)?;

    // One writing turn per session.
    let Some(cancel) = state.begin_turn(&p.session_id) else {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session already has an active turn",
        ));
    };

    let message = match state
        .store
        .append_message(&p.session_id, miniq_protocol::Role::User, &p.message.content)
    {
        Ok(m) => m,
        Err(e) => {
            state.end_turn(&p.session_id);
            return Err(store_err(e));
        }
    };
    state.emit(miniq_protocol::Event::MessageCreated {
        session_id: p.session_id.clone(),
        message: message.clone(),
    });

    if let Err(e) = state
        .store
        .update_session_status(&p.session_id, miniq_protocol::SessionStatus::Running)
    {
        state.end_turn(&p.session_id);
        return Err(store_err(e));
    }
    state.emit(miniq_protocol::Event::SessionStatusChanged {
        session_id: p.session_id.clone(),
        status: miniq_protocol::SessionStatus::Running,
    });

    crate::turn::spawn_turn(state.clone(), p.session_id.clone(), cancel);
    to_value(json!({ "message": message }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCancelParams {
    session_id: String,
}

fn session_cancel(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SessionCancelParams = params(raw)?;
    let cancelled = state.cancel_turn(&p.session_id);
    if cancelled {
        let _ = state
            .store
            .update_session_status(&p.session_id, miniq_protocol::SessionStatus::Cancelling);
        state.emit(miniq_protocol::Event::SessionStatusChanged {
            session_id: p.session_id.clone(),
            status: miniq_protocol::SessionStatus::Cancelling,
        });
    }
    Ok(json!({ "cancelled": cancelled }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalResolveParams {
    approval_id: String,
    /// "approve" | "approve_for_session" | "reject"
    decision: String,
}

fn approval_resolve(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: ApprovalResolveParams = params(raw)?;
    let decision = match p.decision.as_str() {
        "approve" => crate::state::ApprovalDecision::Approve,
        "approve_for_session" => crate::state::ApprovalDecision::ApproveForSession,
        "reject" => crate::state::ApprovalDecision::Reject,
        other => {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                format!("unknown decision: {other}"),
            ))
        }
    };
    let delivered = state.deliver_approval(&p.approval_id, decision);
    if !delivered {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "approval not found or already resolved",
        ));
    }
    Ok(json!({ "resolved": true }))
}

fn tool_list(state: &AppState) -> Result<Value, RpcError> {
    to_value(json!({ "tools": state.router.specs() }))
}

/// Settings view sent to the UI: the API key itself is never echoed back.
fn settings_get(state: &AppState) -> Result<Value, RpcError> {
    let settings = state.settings.lock().unwrap().clone();
    let provider = settings.provider.as_ref().map(|p| {
        json!({
            "baseUrl": p.base_url,
            "model": p.model,
            "hasApiKey": !p.api_key.is_empty(),
        })
    });
    Ok(json!({ "provider": provider }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsUpdateParams {
    provider: ProviderUpdate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUpdate {
    base_url: String,
    model: String,
    /// Omitted or empty => keep the currently stored key.
    #[serde(default)]
    api_key: Option<String>,
}

fn settings_update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SettingsUpdateParams = params(raw)?;
    if p.provider.base_url.trim().is_empty() || p.provider.model.trim().is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "baseUrl and model must not be empty",
        ));
    }
    let mut settings = state.settings.lock().unwrap().clone();
    let existing_key = settings
        .provider
        .as_ref()
        .map(|prev| prev.api_key.clone())
        .unwrap_or_default();
    let api_key = match p.provider.api_key {
        Some(key) if !key.is_empty() => key,
        _ => existing_key,
    };
    settings.provider = Some(miniq_models::ProviderConfig {
        base_url: p.provider.base_url,
        api_key,
        model: p.provider.model,
    });
    state
        .update_settings(settings)
        .map_err(|e| RpcError::new(ErrorCode::InternalError, e))?;
    settings_get(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionOpenParams {
    session_id: String,
}

fn session_open(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SessionOpenParams = params(raw)?;
    let session = state.store.get_session(&p.session_id).map_err(store_err)?;
    let messages = state.store.list_messages(&p.session_id).map_err(store_err)?;
    let tool_calls = state.store.list_tool_calls(&p.session_id).map_err(store_err)?;
    to_value(json!({
        "session": session,
        "messages": messages,
        "toolCalls": tool_calls,
    }))
}
