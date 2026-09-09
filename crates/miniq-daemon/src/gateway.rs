//! JSON-RPC method dispatch.
//!
//! Every request coming over the WebSocket is routed through [`dispatch`].
//! Handlers only coordinate services and never run tools or shell commands
//! directly.

use std::path::Path;

mod agents;
mod common;
mod computer;
mod external_session;
mod external_workspace;
mod interaction;
mod mcp;
mod observation;
mod plugin;
mod schedule;
mod session;
mod session_attention;
mod session_diff;
mod session_history;
mod session_model;
mod settings;
mod skill;
mod system;
mod voice;
mod workspace;
mod workspace_roots;

use miniq_protocol::{ErrorCode, RpcError, RpcRequest, RpcResponse};

use crate::state::AppState;

/// Broadcast the session's current queue (used by the turn runner when it
/// drains a queued message).
pub fn emit_session_queue_changed(state: &AppState, session_id: &str) {
    session::emit_queue_changed(state, session_id);
}

fn canonical_workspace_path(path: &Path) -> Option<String> {
    path.canonicalize()
        .ok()
        .map(|canonical| workspace_path_display(&canonical))
}

fn workspace_path_display(path: &Path) -> String {
    let display = path.to_string_lossy();
    display
        .strip_prefix(r"\\?\")
        .unwrap_or(&display)
        .replace('\\', "/")
}

/// Dispatch one JSON-RPC request while preserving its request identifier.
pub async fn dispatch(state: &AppState, req: RpcRequest) -> RpcResponse {
    let id = req.id.clone();
    let result = match req.method.as_str() {
        "daemon.health" => system::health(state),
        "computer.permissions" => computer::permissions().await,
        "computer.requestPermission" => computer::request(req.params).await,
        "daemon.shutdown" => system::shutdown(state).await,
        "workspace.open" => workspace::open(state, req.params),
        "workspace.create" => workspace::create(state, req.params),
        "workspace.list" => workspace::list(state),
        "workspace.updateRoots" => workspace_roots::update(state, req.params).await,
        "schedule.create" => schedule::create(state, req.params),
        "schedule.list" => schedule::list(state),
        "schedule.toggle" => schedule::toggle(state, req.params),
        "schedule.delete" => schedule::delete(state, req.params),
        "schedule.runNow" => schedule::run_now(state, req.params),
        "session.create" => session::create(state, req.params),
        "session.list" => session::list(state, req.params),
        "session.open" => session::open(state, req.params),
        "session.history" => session_history::page(state, req.params),
        "session.sync" => session_history::sync(state, req.params),
        "tool.detail" => session_history::tool_detail(state, req.params),
        "session.acknowledgeFailure" => session_attention::acknowledge_failure(state, req.params),
        "session.modelGet" => session_model::get(state, req.params),
        "session.modelUpdate" => session_model::update(state, req.params).await,
        "model.list" => session_model::catalog(state).await,
        "model.describe" => session_model::describe(state, req.params).await,
        "agent.list" => agents::list(state, req.params).await,
        "agent.output" => agents::action(state, req.params, false).await,
        "agent.stop" => agents::action(state, req.params, true).await,
        "session.diff" => session_diff::get(state, req.params),
        "session.sendMessage" => session::send_message(state, req.params),
        "session.rewriteMessage" => session::rewrite_message(state, req.params),
        "session.cancel" => session::cancel(state, req.params).await,
        "session.queueList" => session::queue_list(state, req.params),
        "session.queueRemove" => session::queue_remove(state, req.params),
        "session.queueSteer" => session::queue_steer(state, req.params),
        "session.rename" => session::rename(state, req.params),
        "session.setPinned" => session::set_pinned(state, req.params),
        "session.setArchived" => session::set_archived(state, req.params),
        "session.delete" => session::delete(state, req.params),
        "session.search" => session::search(state, req.params),
        "workspace.rename" => workspace::rename(state, req.params),
        "workspace.delete" => workspace::delete(state, req.params),
        "externalSession.scan" => external_session::scan().await,
        "externalSession.import" => external_session::import(state, req.params).await,
        "approval.resolve" => interaction::resolve_approval(state, req.params),
        "question.resolve" => interaction::resolve_question(state, req.params),
        "checkpoint.rollback" => interaction::rollback_checkpoint(state, req.params),
        "tool.list" => system::list_tools(state),
        "observation.read" => observation::read(state, req.params).await,
        "settings.get" => settings::get(state),
        "settings.models" => settings::models(state, req.params).await,
        "settings.update" => settings::update(state, req.params),
        "remote.status" => serde_json::to_value(crate::remote::status(state))
            .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string())),
        "voice.transcribe" => voice::transcribe(state, req.params).await,
        "skill.list" => skill::list(state, req.params),
        "skill.read" => skill::read(state, req.params),
        "skill.setEnabled" => skill::set_enabled(state, req.params),
        "skill.delete" => skill::delete(state, req.params),
        "skill.distill" => skill::distill(state, req.params).await,
        "skill.refine" => skill::refine(state, req.params).await,
        "skill.save" => skill::save(state, req.params),
        "mcp.list" => mcp::list(state, req.params).await,
        "mcp.update" => mcp::update(state, req.params),
        "plugin.list" => plugin::list(state),
        "plugin.install" => plugin::install(state, req.params).await,
        "plugin.uninstall" => plugin::uninstall(state, req.params).await,
        "plugin.reload" => plugin::reload(state, req.params).await,
        "plugin.setEnabled" => plugin::set_enabled(state, req.params).await,
        "plugin.getDiagnostics" => plugin::diagnostics(state, req.params),
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
