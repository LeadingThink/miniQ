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
        "question.resolve" => question_resolve(state, req.params),
        "checkpoint.rollback" => checkpoint_rollback(state, req.params),
        "tool.list" => tool_list(state),
        "settings.get" => settings_get(state),
        "settings.update" => settings_update(state, req.params),
        "skill.list" => skill_list(state, req.params),
        "skill.read" => skill_read(state, req.params),
        "skill.setEnabled" => skill_set_enabled(state, req.params),
        "skill.delete" => skill_delete(state, req.params),
        "skill.distill" => skill_distill(state, req.params).await,
        "skill.refine" => skill_refine(state, req.params).await,
        "skill.save" => skill_save(state, req.params),
        "mcp.list" => mcp_list(state, req.params).await,
        "mcp.update" => mcp_update(state, req.params),
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
    let session = state.store.get_session(&p.session_id).map_err(store_err)?;

    // One writing turn per session and per workspace.
    let Some(cancel) = state.begin_turn(&p.session_id, &session.workspace_id) else {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session or workspace already has an active turn",
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

    // First message names the session (like every chat app).
    if session.title == "New session" {
        let title: String = p.message.content.trim().chars().take(30).collect();
        if !title.is_empty() {
            let _ = state.store.update_session_title(&p.session_id, &title);
        }
    }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionResolveParams {
    question_id: String,
    answer: String,
}

fn question_resolve(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: QuestionResolveParams = params(raw)?;
    if !state.deliver_answer(&p.question_id, p.answer) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "question not found or already answered",
        ));
    }
    Ok(json!({ "resolved": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointRollbackParams {
    checkpoint_id: String,
}

fn checkpoint_rollback(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: CheckpointRollbackParams = params(raw)?;
    let checkpoint = state.store.get_checkpoint(&p.checkpoint_id).map_err(store_err)?;
    let target = std::path::Path::new(&checkpoint.abs_path);
    if checkpoint.existed {
        let backup = checkpoint.backup_path.as_deref().ok_or_else(|| {
            RpcError::new(ErrorCode::InternalError, "checkpoint has no backup file")
        })?;
        std::fs::copy(backup, target)
            .map_err(|e| RpcError::new(ErrorCode::InternalError, format!("restore: {e}")))?;
    } else if target.exists() {
        // File did not exist before the tool ran: rollback = remove it.
        std::fs::remove_file(target)
            .map_err(|e| RpcError::new(ErrorCode::InternalError, format!("remove: {e}")))?;
    }
    let _ = state.store.append_audit_event(
        Some(&checkpoint.session_id),
        "checkpoint_rollback",
        &json!({"checkpointId": checkpoint.id, "path": checkpoint.abs_path}),
    );
    Ok(json!({ "restored": checkpoint.abs_path, "existedBefore": checkpoint.existed }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillScopeParams {
    /// Include this workspace's project skills in scope.
    #[serde(default)]
    workspace_id: Option<String>,
}

/// Resolve the optional workspace path used for project-skill scoping.
fn skill_workspace(state: &AppState, workspace_id: Option<&str>) -> Result<Option<std::path::PathBuf>, RpcError> {
    match workspace_id {
        Some(id) => {
            let ws = state.store.get_workspace(id).map_err(store_err)?;
            Ok(Some(std::path::PathBuf::from(ws.path)))
        }
        None => Ok(None),
    }
}

fn skill_err(e: miniq_skills::StoreError) -> RpcError {
    match &e {
        miniq_skills::StoreError::NotFound(_) => {
            RpcError::new(ErrorCode::InvalidParams, e.to_string())
        }
        _ => RpcError::new(ErrorCode::InternalError, e.to_string()),
    }
}

fn skill_list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SkillScopeParams = params(raw)?;
    let workspace = skill_workspace(state, p.workspace_id.as_deref())?;
    let skills = state.skills.discover(workspace.as_deref());
    to_value(json!({ "skills": skills }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillReadParams {
    name: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

fn skill_read(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SkillReadParams = params(raw)?;
    let workspace = skill_workspace(state, p.workspace_id.as_deref())?;
    let detail = state
        .skills
        .read(workspace.as_deref(), &p.name)
        .map_err(skill_err)?;
    to_value(detail)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillSetEnabledParams {
    name: String,
    enabled: bool,
}

fn skill_set_enabled(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SkillSetEnabledParams = params(raw)?;
    state.skills.set_enabled(&p.name, p.enabled).map_err(skill_err)?;
    Ok(json!({ "name": p.name, "enabled": p.enabled }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillDeleteParams {
    name: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

fn skill_delete(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SkillDeleteParams = params(raw)?;
    let workspace = skill_workspace(state, p.workspace_id.as_deref())?;
    state
        .skills
        .delete(workspace.as_deref(), &p.name)
        .map_err(skill_err)?;
    Ok(json!({ "deleted": p.name }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillDistillParams {
    session_id: String,
}

async fn skill_distill(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SkillDistillParams = params(raw)?;
    state.store.get_session(&p.session_id).map_err(store_err)?;
    if !crate::learn::has_completed_turn(state, &p.session_id) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "session has no completed turn to distill",
        ));
    }
    let transcript = crate::learn::build_transcript(state, &p.session_id)
        .map_err(|e| RpcError::new(ErrorCode::InternalError, e))?;
    let existing: Vec<String> = state
        .skills
        .discover(None)
        .into_iter()
        .map(|s| s.meta.name)
        .collect();
    let inference = crate::learn::ProviderInference {
        provider: state.current_provider(),
    };
    let outcome = miniq_skills::distill_skill(&transcript, &existing, &inference)
        .await
        .map_err(|e| RpcError::new(ErrorCode::InternalError, e.to_string()))?;
    match outcome {
        miniq_skills::DistillOutcome::Skipped { reason } => {
            Ok(json!({ "skipped": true, "reason": reason }))
        }
        miniq_skills::DistillOutcome::Draft {
            content,
            name,
            description,
            warnings,
        } => {
            let existing_skill = existing.contains(&name);
            Ok(json!({
                "skipped": false,
                "content": content,
                "name": name,
                "description": description,
                "warnings": warnings,
                "existingSkill": existing_skill,
            }))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillRefineParams {
    session_id: String,
    name: String,
}

async fn skill_refine(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SkillRefineParams = params(raw)?;
    let detail = state.skills.read(None, &p.name).map_err(skill_err)?;
    let existing_md =
        miniq_skills::render_skill_md(&detail.skill.meta, &detail.body);
    let transcript = crate::learn::build_transcript(state, &p.session_id)
        .map_err(|e| RpcError::new(ErrorCode::InternalError, e))?;
    let inference = crate::learn::ProviderInference {
        provider: state.current_provider(),
    };
    let outcome = miniq_skills::refine_skill(&existing_md, &transcript, &inference)
        .await
        .map_err(|e| RpcError::new(ErrorCode::InternalError, e.to_string()))?;
    match outcome {
        miniq_skills::RefineOutcome::Kept => Ok(json!({ "kept": true })),
        miniq_skills::RefineOutcome::Updated { content, warnings } => Ok(json!({
            "kept": false,
            "content": content,
            "warnings": warnings,
        })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillSaveParams {
    content: String,
    /// Save even when sensitive-content warnings remain (user confirmed).
    #[serde(default)]
    force: bool,
}

fn skill_save(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SkillSaveParams = params(raw)?;
    let warnings = miniq_skills::scan_sensitive(&p.content);
    if !warnings.is_empty() && !p.force {
        let mut err = RpcError::new(
            ErrorCode::InvalidParams,
            "draft contains possibly sensitive content; edit it or pass force=true",
        );
        err.data = Some(json!({ "warnings": warnings }));
        return Err(err);
    }
    let meta = state.skills.save(&p.content).map_err(skill_err)?;
    let _ = state.store.append_audit_event(
        None,
        "skill_saved",
        &json!({"name": meta.name, "version": meta.version}),
    );
    to_value(json!({ "name": meta.name, "version": meta.version }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpListParams {
    /// Connect to enabled servers and fetch their tool lists.
    #[serde(default)]
    connect: bool,
}

async fn mcp_list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: McpListParams = params(raw)?;
    let servers = state.settings.lock().unwrap().mcp_servers.clone();
    let mut out = Vec::new();
    for server in servers {
        let mut entry = json!({
            "name": server.name,
            "command": server.command,
            "args": server.args,
            "enabled": server.enabled,
        });
        if p.connect && server.enabled {
            match state.mcp.list_tools(&server).await {
                Ok(tools) => {
                    entry["status"] = json!("running");
                    entry["tools"] = json!(tools);
                }
                Err(e) => {
                    entry["status"] = json!("error");
                    entry["error"] = json!(e);
                }
            }
        } else {
            entry["status"] = json!(if server.enabled { "configured" } else { "disabled" });
        }
        out.push(entry);
    }
    Ok(json!({ "servers": out }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpUpdateParams {
    servers: Vec<crate::mcp::McpServerConfig>,
}

/// Replace the MCP server list (add/remove/enable are all list edits).
fn mcp_update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: McpUpdateParams = params(raw)?;
    for server in &p.servers {
        if server.name.trim().is_empty() || server.command.trim().is_empty() {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "server name and command must not be empty",
            ));
        }
    }
    let mut settings = state.settings.lock().unwrap().clone();
    settings.mcp_servers = p.servers;
    state
        .update_settings(settings)
        .map_err(|e| RpcError::new(ErrorCode::InternalError, e))?;
    Ok(json!({ "ok": true }))
}

/// Settings view sent to the UI: API keys are never echoed back.
fn settings_get(state: &AppState) -> Result<Value, RpcError> {
    let settings = state.settings.lock().unwrap().clone();
    let provider = settings.provider.as_ref().map(|p| {
        json!({
            "baseUrl": p.base_url,
            "model": p.model,
            "hasApiKey": !p.api_key.is_empty(),
        })
    });
    let search = settings.search.as_ref().map(|s| {
        json!({
            "provider": s.provider,
            "baseUrl": s.base_url,
            "hasApiKey": !s.api_key.is_empty(),
        })
    });
    Ok(json!({ "provider": provider, "search": search }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsUpdateParams {
    /// Absent => keep current provider settings.
    #[serde(default)]
    provider: Option<ProviderUpdate>,
    /// Absent => keep current search settings.
    #[serde(default)]
    search: Option<SearchUpdate>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchUpdate {
    #[serde(default = "default_search_provider")]
    provider: String,
    #[serde(default)]
    base_url: Option<String>,
    /// Omitted or empty => keep the currently stored key.
    #[serde(default)]
    api_key: Option<String>,
}

fn default_search_provider() -> String {
    "tavily".to_string()
}

/// Merge an optional new key over the existing one (empty/absent keeps old).
fn merged_key(new_key: Option<String>, existing: Option<String>) -> String {
    match new_key {
        Some(key) if !key.is_empty() => key,
        _ => existing.unwrap_or_default(),
    }
}

fn settings_update(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: SettingsUpdateParams = params(raw)?;
    let mut settings = state.settings.lock().unwrap().clone();

    if let Some(provider) = p.provider {
        if provider.base_url.trim().is_empty() || provider.model.trim().is_empty() {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "provider baseUrl and model must not be empty",
            ));
        }
        let existing_key = settings.provider.as_ref().map(|prev| prev.api_key.clone());
        settings.provider = Some(miniq_models::ProviderConfig {
            base_url: provider.base_url,
            api_key: merged_key(provider.api_key, existing_key),
            model: provider.model,
        });
    }

    if let Some(search) = p.search {
        let existing_key = settings.search.as_ref().map(|prev| prev.api_key.clone());
        settings.search = Some(miniq_tools::SearchConfig {
            provider: search.provider,
            api_key: merged_key(search.api_key, existing_key),
            base_url: search.base_url,
        });
    }

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
    let artifacts = state.store.list_artifacts(&p.session_id).map_err(store_err)?;
    let plan = state
        .plans
        .lock()
        .unwrap()
        .get(&p.session_id)
        .cloned()
        .unwrap_or_default();
    to_value(json!({
        "session": session,
        "messages": messages,
        "toolCalls": tool_calls,
        "artifacts": artifacts,
        "plan": plan,
    }))
}
