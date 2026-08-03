//! JSON-RPC method dispatch.
//!
//! Every request coming over the WebSocket is routed through [`dispatch`].
//! Handlers only coordinate services and never run tools or shell commands
//! directly.

use std::path::Path;

mod common;
mod external_session;
mod external_workspace;
mod interaction;
mod mcp;
mod schedule;
mod session;
mod settings;
mod skill;
mod system;
mod workspace;

use miniq_protocol::{ErrorCode, RpcError, RpcRequest, RpcResponse};

use crate::state::AppState;

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
        "daemon.shutdown" => system::shutdown(state),
        "workspace.open" => workspace::open(state, req.params),
        "workspace.create" => workspace::create(state, req.params),
        "workspace.list" => workspace::list(state),
        "schedule.create" => schedule::create(state, req.params),
        "schedule.list" => schedule::list(state),
        "schedule.toggle" => schedule::toggle(state, req.params),
        "schedule.delete" => schedule::delete(state, req.params),
        "schedule.runNow" => schedule::run_now(state, req.params),
        "session.create" => session::create(state, req.params),
        "session.list" => session::list(state, req.params),
        "session.open" => session::open(state, req.params),
        "session.sendMessage" => session::send_message(state, req.params),
        "session.cancel" => session::cancel(state, req.params),
        "externalSession.scan" => external_session::scan().await,
        "externalSession.import" => external_session::import(state, req.params).await,
        "approval.resolve" => interaction::resolve_approval(state, req.params),
        "question.resolve" => interaction::resolve_question(state, req.params),
        "checkpoint.rollback" => interaction::rollback_checkpoint(state, req.params),
        "tool.list" => system::list_tools(state),
        "settings.get" => settings::get(state),
        "settings.update" => settings::update(state, req.params),
        "skill.list" => skill::list(state, req.params),
        "skill.read" => skill::read(state, req.params),
        "skill.setEnabled" => skill::set_enabled(state, req.params),
        "skill.delete" => skill::delete(state, req.params),
        "skill.distill" => skill::distill(state, req.params).await,
        "skill.refine" => skill::refine(state, req.params).await,
        "skill.save" => skill::save(state, req.params),
        "mcp.list" => mcp::list(state, req.params).await,
        "mcp.update" => mcp::update(state, req.params),
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
