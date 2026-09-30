//! Terminal-parity session maintenance: undo the last exchange, force a
//! context compaction, and report how much of the model context is in use.

use miniq_protocol::{ErrorCode, Event, Role, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use super::session_queue::emit_queue_changed;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoParams {
    session_id: String,
    #[serde(default)]
    message_id: Option<String>,
    /// Restore files edited after the undone prompt (default true).
    #[serde(default = "default_true")]
    restore_files: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

/// Remove the latest (or given) user prompt and everything after it, and
/// restore files the agent changed since then from their checkpoints.
pub(super) fn undo(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: UndoParams = params(raw)?;
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let message_id = match input.message_id {
        Some(id) => id,
        None => state
            .store
            .list_messages(&input.session_id)
            .map_err(store_err)?
            .into_iter()
            .rev()
            .find(|message| message.role == Role::User)
            .map(|message| message.id)
            .ok_or_else(|| RpcError::new(ErrorCode::InvalidParams, "nothing to undo"))?,
    };
    if state.begin_turn(&input.session_id).is_none() {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session already has an active turn",
        ));
    }
    let result = undo_locked(state, &input.session_id, &message_id, input.restore_files);
    state.end_turn(&input.session_id);
    result
}

fn undo_locked(
    state: &AppState,
    session_id: &str,
    message_id: &str,
    restore_files: bool,
) -> Result<Value, RpcError> {
    // Checkpoint rows are deleted with the transcript, so read them first.
    let checkpoints = state
        .store
        .checkpoints_since_user_message(session_id, message_id)
        .map_err(store_err)?;
    let rewrite = state
        .store
        .undo_session_to_user_message(session_id, message_id)
        .map_err(store_err)?;
    let mut restored = Vec::new();
    let mut failed = Vec::new();
    if restore_files {
        // Newest first so the oldest backup (pre-turn content) wins.
        let mut seen = std::collections::HashSet::new();
        for checkpoint in checkpoints.iter().rev() {
            match super::interaction::restore_checkpoint(checkpoint) {
                Ok(()) => {
                    let _ = state.store.append_audit_event(
                        Some(session_id),
                        "checkpoint_rollback",
                        &json!({"checkpointId": checkpoint.id, "path": checkpoint.abs_path, "reason": "undo"}),
                    );
                    if seen.insert(checkpoint.abs_path.clone()) {
                        restored.push(checkpoint.abs_path.clone());
                    }
                }
                Err(error) => {
                    failed.push(json!({"path": checkpoint.abs_path, "error": error.message}))
                }
            }
        }
        // Report in first-edited order.
        restored.reverse();
    }
    let _ = state.store.append_audit_event(
        Some(session_id),
        "session_undo",
        &json!({"messageId": message_id, "restoredFiles": restored.len()}),
    );
    state.emit(Event::SessionRewritten {
        session_id: session_id.to_string(),
        message: rewrite.message.clone(),
        removed_message_ids: rewrite.removed_message_ids.clone(),
        removed_tool_call_ids: rewrite.removed_tool_call_ids,
        removed_artifact_ids: rewrite.removed_artifact_ids,
    });
    emit_queue_changed(state, session_id);
    to_value(json!({
        "removedMessage": rewrite.message,
        "removedMessageIds": rewrite.removed_message_ids,
        "restoredFiles": restored,
        "failedFiles": failed,
    }))
}

/// Summarize the conversation now instead of waiting for the automatic
/// threshold. The newest user exchange is preserved verbatim.
pub(super) async fn compact(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionParams = params(raw)?;
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let Some(cancel) = state.begin_turn(&input.session_id) else {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session already has an active turn",
        ));
    };
    let result = compact_locked(state, &session, cancel).await;
    state.end_turn(&input.session_id);
    result
}

async fn compact_locked(
    state: &AppState,
    session: &miniq_protocol::Session,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<Value, RpcError> {
    let session_id = session.id.as_str();
    let internal = |error: String| RpcError::new(ErrorCode::InternalError, error);
    let messages = state.store.list_messages(session_id).map_err(store_err)?;
    let Some(last) = messages.last() else {
        return to_value(json!({"compacted": false, "reason": "empty"}));
    };
    let snapshot = state
        .store
        .get_model_context(session_id)
        .map_err(store_err)?;
    let config = state
        .provider_config_for_session(session_id, None)
        .map_err(|error| internal(error.to_string()))?;
    let model_identity = crate::session_models::model_identity(config.as_ref());
    let previous_identity = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.model_identity.clone());
    let workspace_path = std::path::PathBuf::from(&session.working_directory);
    let mut history = crate::turn::history_for_turn(&messages, snapshot, "", &workspace_path);
    crate::session_models::isolate_native_context(
        &mut history,
        previous_identity.as_deref(),
        model_identity.as_deref(),
    );
    let mut policy = crate::turn::context_policy();
    policy.soft_limit_tokens = 1;
    policy.preserve_recent_messages = 2;
    let turn_id = miniq_memory::new_id("compact");
    let provider = crate::observed_provider::ObservedProvider::new(
        state.provider_from_config(config),
        state.store.clone(),
        session_id.to_owned(),
        None,
        turn_id,
        Some(last.id.clone()),
    );
    let (events, mut drain) = tokio::sync::mpsc::channel(64);
    let drainer = tokio::spawn(async move { while drain.recv().await.is_some() {} });
    let outcome =
        miniq_agent::compact_history(&provider, history, &[], &policy, 2, &events, &cancel).await;
    drop(events);
    let _ = drainer.await;
    let outcome = outcome.map_err(|error| internal(error.to_string()))?;
    if !outcome.compacted {
        return to_value(json!({
            "compacted": false,
            "reason": "nothing_to_compact",
            "estimatedTokensBefore": outcome.estimated_tokens_before,
            "estimatedTokensAfter": outcome.estimated_tokens_after,
        }));
    }
    let mut persisted = outcome.messages.into_iter().skip(1).collect::<Vec<_>>();
    crate::security::redact_provider_history(&mut persisted);
    let persisted = serde_json::to_value(persisted).map_err(|error| internal(error.to_string()))?;
    state
        .store
        .save_model_context(session_id, &last.id, &persisted, model_identity.as_deref())
        .map_err(store_err)?;
    let _ = state.store.append_audit_event(
        Some(session_id),
        "context_compacted",
        &json!({
            "manual": true,
            "estimatedTokensBefore": outcome.estimated_tokens_before,
            "estimatedTokensAfter": outcome.estimated_tokens_after,
        }),
    );
    state.emit(Event::ContextCompacted {
        session_id: session_id.to_string(),
        estimated_tokens_before: outcome.estimated_tokens_before,
        estimated_tokens_after: outcome.estimated_tokens_after,
    });
    to_value(json!({
        "compacted": true,
        "estimatedTokensBefore": outcome.estimated_tokens_before,
        "estimatedTokensAfter": outcome.estimated_tokens_after,
    }))
}

/// Estimated context occupancy for status lines. Cheap: no model request
/// except a cached (and time-bounded) capability lookup.
pub(super) async fn context_usage(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionParams = params(raw)?;
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let messages = state
        .store
        .list_messages(&input.session_id)
        .map_err(store_err)?;
    let snapshot = state
        .store
        .get_model_context(&input.session_id)
        .map_err(store_err)?;
    let workspace_path = std::path::PathBuf::from(&session.working_directory);
    let history = crate::turn::history_for_turn(&messages, snapshot, "", &workspace_path);
    let estimated = miniq_agent::estimate_request_tokens(&history, &[]);
    let last_call = state
        .store
        .model_calls_page(&miniq_protocol::ModelCallsParams {
            session_id: input.session_id.clone(),
            agent_id: None,
            before: None,
            limit: 20,
        })
        .ok()
        .and_then(|page| page.calls.into_iter().find(|call| call.agent_id.is_none()));
    let config = state
        .provider_config_for_session(&input.session_id, None)
        .ok()
        .flatten();
    let window = match config {
        Some(config) => {
            let provider = state.provider_from_config(Some(config));
            tokio::time::timeout(std::time::Duration::from_secs(3), provider.capabilities())
                .await
                .ok()
                .and_then(|capabilities| capabilities.max_context_tokens)
        }
        None => None,
    }
    .or_else(|| {
        last_call
            .as_ref()
            .and_then(|call| call.advertised_context_tokens)
    });
    let mut soft_limit = crate::turn::context_policy().soft_limit_tokens;
    if let Some(window) = window {
        // Mirrors miniq_agent's effective policy (default output reserve).
        let input_limit = window
            .saturating_sub(16_384)
            .saturating_sub((window / 20).max(1_024)) as usize;
        if input_limit > 0 {
            soft_limit = soft_limit.min(input_limit);
        }
    }
    let percent = window
        .map(|window| ((estimated as f64 / f64::from(window.max(1))) * 100.0).clamp(0.0, 100.0));
    to_value(json!({
        "estimatedTokens": estimated,
        "contextWindowTokens": window,
        "autoCompactTokens": soft_limit,
        "percentUsed": percent,
        "lastRequestTokens": last_call.map(|call| call.estimated_input_tokens),
    }))
}
