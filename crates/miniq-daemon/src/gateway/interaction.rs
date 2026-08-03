use std::path::Path;

use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err};
use crate::state::{AppState, ApprovalDecision};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalParams {
    approval_id: String,
    decision: String,
}

pub(super) fn resolve_approval(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ApprovalParams = params(raw)?;
    let decision = parse_decision(&input.decision)?;
    if !state.deliver_approval(&input.approval_id, decision) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "approval not found or already resolved",
        ));
    }
    Ok(json!({ "resolved": true }))
}

fn parse_decision(decision: &str) -> Result<ApprovalDecision, RpcError> {
    match decision {
        "approve" => Ok(ApprovalDecision::Approve),
        "approve_for_session" => Ok(ApprovalDecision::ApproveForSession),
        "reject" => Ok(ApprovalDecision::Reject),
        other => Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("unknown decision: {other}"),
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionParams {
    question_id: String,
    answer: String,
}

pub(super) fn resolve_question(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QuestionParams = params(raw)?;
    if !state.deliver_answer(&input.question_id, input.answer) {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "question not found or already answered",
        ));
    }
    Ok(json!({ "resolved": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RollbackParams {
    checkpoint_id: String,
}

pub(super) fn rollback_checkpoint(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: RollbackParams = params(raw)?;
    let checkpoint = state
        .store
        .get_checkpoint(&input.checkpoint_id)
        .map_err(store_err)?;
    restore_checkpoint(&checkpoint)?;
    let _ = state.store.append_audit_event(
        Some(&checkpoint.session_id),
        "checkpoint_rollback",
        &json!({"checkpointId": checkpoint.id, "path": checkpoint.abs_path}),
    );
    Ok(json!({
        "restored": checkpoint.abs_path,
        "existedBefore": checkpoint.existed,
    }))
}

fn restore_checkpoint(checkpoint: &miniq_memory::CheckpointRow) -> Result<(), RpcError> {
    let target = Path::new(&checkpoint.abs_path);
    if checkpoint.existed {
        let backup = checkpoint.backup_path.as_deref().ok_or_else(|| {
            RpcError::new(ErrorCode::InternalError, "checkpoint has no backup file")
        })?;
        std::fs::copy(backup, target).map_err(|error| {
            RpcError::new(ErrorCode::InternalError, format!("restore: {error}"))
        })?;
    } else if target.exists() {
        std::fs::remove_file(target)
            .map_err(|error| RpcError::new(ErrorCode::InternalError, format!("remove: {error}")))?;
    }
    Ok(())
}
