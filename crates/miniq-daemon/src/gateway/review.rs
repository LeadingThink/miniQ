use super::common::{params, to_value};
use crate::state::AppState;
use miniq_models::{ConfiguredProvider, ModelProvider};
use miniq_protocol::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn err(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, error.to_string())
}

pub(super) fn start(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ReviewStartParams = params(raw)?;
    if input.model.trim().is_empty() || input.model.trim() != input.model {
        return Err(err("model must be a nonempty model id"));
    }
    state.store.get_session(&input.session_id).map_err(err)?;
    let mut jobs = state.review_jobs.lock().unwrap();
    let mut snapshot = state
        .store
        .review_turn_snapshot(&input.session_id, &input.primary_message_id)
        .map_err(err)?;
    if state.has_active_turn(&input.session_id) {
        let latest = state
            .store
            .last_user_message(&input.session_id)
            .map_err(err)?;
        if latest
            .as_ref()
            .is_some_and(|m| m.id == snapshot.user_message_id)
        {
            return Err(err("primary turn is still running"));
        }
    }
    // Reuse the original frozen diff even after unrelated workspace edits.
    let (previous, _) = state
        .store
        .list_reviews(
            &input.session_id,
            Some(&input.primary_message_id),
            100,
            None,
        )
        .map_err(err)?;
    for run in previous {
        let stored = state
            .store
            .review_snapshot(&input.session_id, &run.id)
            .map_err(err)?;
        if stored.user_prompt == snapshot.user_prompt
            && stored.answer == snapshot.answer
            && stored.tools == snapshot.tools
        {
            snapshot.diff = stored.diff;
            snapshot.limitations = stored.limitations;
            break;
        }
    }
    if snapshot.diff.is_null() {
        super::review_snapshot::capture_diff(state, &mut snapshot)?;
    }
    let encoded = serde_json::to_string(&snapshot).map_err(err)?;
    if encoded.len() > crate::review::INPUT_BUDGET {
        return Err(err(
            "review snapshot exceeds 60 KiB input budget; no evidence was truncated",
        ));
    }
    let key = format!("{:x}", Sha256::digest(encoded.as_bytes()));
    if let Some(run) = state
        .store
        .review_by_key(
            &input.session_id,
            &input.primary_message_id,
            &input.model,
            &key,
        )
        .map_err(err)?
    {
        return to_value(json!({"run":run}));
    }
    let primary = state
        .provider_config_for_session(&input.session_id, None)
        .map_err(err)?;
    if primary.as_ref().is_some_and(|c| c.model == input.model) {
        return Err(err("review model must differ from the primary model"));
    }
    let mut config = state
        .provider_config_for_session(&input.session_id, Some(&input.model))
        .map_err(err)?;
    if let Some(config) = config.as_mut() {
        config.api_protocol = ApiProtocol::Auto;
        config.reasoning_effort = None;
    }
    let provider: Arc<dyn ModelProvider> = if let Some(p) = &state.provider_override {
        p.clone()
    } else {
        Arc::new(ConfiguredProvider::new(
            config.ok_or_else(|| err("model provider is not configured"))?,
        ))
    };
    let mut run = state
        .store
        .create_review(&snapshot, &input.model, &key)
        .map_err(err)?;
    run.evidence = crate::review::evidence_for_snapshot(&snapshot);
    state.store.update_review(&run).map_err(err)?;
    let token = CancellationToken::new();
    jobs.insert(run.id.clone(), token.clone());
    let background = state.clone();
    let running = run.clone();
    tokio::spawn(async move {
        crate::review::execute(background, running, snapshot, provider, token).await;
    });
    to_value(json!({"run":run}))
}

fn validated_run(state: &AppState, session: &str, id: &str) -> Result<ReviewRun, RpcError> {
    state.store.get_session(session).map_err(err)?;
    let mut run = state.store.get_review(session, id).map_err(err)?;
    let original = state.store.review_snapshot(session, id).map_err(err)?;
    let current = state
        .store
        .review_turn_snapshot(session, &run.primary_message_id);
    if current.is_err()
        || current
            .as_ref()
            .is_ok_and(|s| s.answer != original.answer || s.user_prompt != original.user_prompt)
    {
        if let Some(token) = state.review_jobs.lock().unwrap().get(id) {
            token.cancel();
        }
        run.status = ReviewStatus::Stale;
        run.verdict = None;
        run.findings.clear();
        run.error = Some("primary evidence was removed or changed".into());
        run.completed_at = Some(miniq_memory::now_iso());
        state.store.update_review(&run).map_err(err)?;
    }
    Ok(run)
}
pub(super) fn get(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: ReviewIdParams = params(raw)?;
    to_value(json!({"run":validated_run(state,&p.session_id,&p.review_id)?}))
}
pub(super) fn cancel(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: ReviewIdParams = params(raw)?;
    let mut run = validated_run(state, &p.session_id, &p.review_id)?;
    let jobs = state.review_jobs.lock().unwrap();
    if matches!(run.status, ReviewStatus::Queued | ReviewStatus::Running) {
        if let Some(token) = jobs.get(&run.id) {
            token.cancel();
        }
        run.status = ReviewStatus::Cancelled;
        run.completed_at = Some(miniq_memory::now_iso());
        state.store.update_review(&run).map_err(err)?;
    }
    to_value(json!({"run":run}))
}
pub(super) fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let p: ReviewListParams = params(raw)?;
    state.store.get_session(&p.session_id).map_err(err)?;
    // Review history survives deletion of its primary message. Reject an ID owned by
    // another session, but allow a deleted primary that has this session's review history.
    if let Some(id) = p.primary_message_id.as_deref() {
        state
            .store
            .validate_review_message_filter(&p.session_id, id)
            .map_err(err)?;
    }
    if let Some(id) = p.cursor.as_deref() {
        state.store.get_review(&p.session_id, id).map_err(err)?;
    }
    let (runs, next_cursor) = state
        .store
        .list_reviews(
            &p.session_id,
            p.primary_message_id.as_deref(),
            p.limit,
            p.cursor.as_deref(),
        )
        .map_err(err)?;
    let runs = runs
        .into_iter()
        .map(|r| validated_run(state, &p.session_id, &r.id))
        .collect::<Result<_, _>>()?;
    to_value(ReviewListResult { runs, next_cursor })
}
