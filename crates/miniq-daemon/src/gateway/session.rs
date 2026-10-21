use miniq_protocol::{
    ErrorCode, Event, MessageAttachment, Role, RpcError, SessionGoalStatus, SessionStatus,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{history_err, params, store_err, to_value};
use crate::state::AppState;

mod admission;
mod attachments;

#[cfg(test)]
#[path = "session/admission_tests.rs"]
mod admission_tests;

#[cfg(test)]
#[path = "session/pause_tests.rs"]
mod pause_tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    workspace_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    model_settings: Option<miniq_protocol::SessionModelSettings>,
}

pub(super) async fn create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CreateParams = params(raw)?;
    state
        .store
        .get_workspace(&input.workspace_id)
        .map_err(store_err)?;
    let baseline = state.settings.lock().unwrap().provider.clone();
    let selection = match input.model_settings {
        Some(mut settings) => {
            super::session_model::validate_settings(&baseline, &mut settings).await?;
            settings
        }
        None => state
            .store
            .workspace_model_settings(&input.workspace_id)
            .map_err(store_err)?,
    };
    let selection = crate::session_models::snapshot_selection(baseline, selection);
    let automatic_title = input.title.is_none();
    let title = input.title.unwrap_or_else(|| "New session".to_string());
    let session = state
        .store
        .create_session_with_model_settings(&input.workspace_id, &title, Some(&selection))
        .map_err(store_err)?;
    if automatic_title {
        state
            .store
            .enable_automatic_title(&session.id)
            .map_err(store_err)?;
    }
    state.emit(Event::SessionStatusChanged {
        session_id: session.id.clone(),
        status: session.status,
    });
    crate::hooks::spawn_event(
        state,
        &session.id,
        crate::hooks::HookEvent::SessionStart,
        crate::hooks::HookPayload::default(),
    );
    to_value(session)
}

pub(super) fn fork(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: miniq_protocol::SessionForkParams = params(raw)?;
    let boundary = (input.mode == miniq_protocol::SessionForkMode::Side)
        .then_some(crate::side_conversation::BOUNDARY_PROMPT);
    let session = state
        .store
        .fork_session(
            &input.session_id,
            input.anchor_message_id.as_deref(),
            input.title.as_deref(),
            input.mode,
            boundary,
        )
        .map_err(store_err)?;
    state.emit(Event::SessionStatusChanged {
        session_id: session.id.clone(),
        status: session.status,
    });
    to_value(session)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(default)]
    workspace_id: Option<String>,
}

pub(super) fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ListParams = params(raw)?;
    let sessions = state
        .store
        .list_sessions(input.workspace_id.as_deref())
        .map_err(store_err)?;
    to_value(json!({ "sessions": sessions }))
}

pub(super) fn open(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let started = std::time::Instant::now();
    let input: miniq_protocol::HistoryParams = params(raw)?;
    let journal = state.event_journal.lock().unwrap();
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let history = state.store.history_page(&input).map_err(history_err)?;
    let artifacts = state
        .store
        .list_artifacts(&input.session_id)
        .map_err(store_err)?;
    let plan = state
        .store
        .session_plan(&input.session_id)
        .map_err(store_err)?;
    let turn_plans = state
        .store
        .session_turn_plans(&input.session_id)
        .map_err(store_err)?;
    let queue = state
        .store
        .list_queued_messages(&input.session_id)
        .map_err(store_err)?;
    let approvals = state
        .store
        .list_pending_approval_requests(&input.session_id)
        .map_err(store_err)?
        .into_iter()
        .map(|request| {
            json!({
                "approval": request.approval,
                "toolName": request.tool_name,
                "input": request.input,
            })
        })
        .collect::<Vec<_>>();
    let questions = state.pending_questions_for_session(&input.session_id);
    let streaming_text = state.streaming_text(&input.session_id);
    let turn_progress = state.turn_progress(&input.session_id);
    let goal = state
        .store
        .session_goal(&input.session_id)
        .map_err(store_err)?;
    let fork = state
        .store
        .session_fork_info(&input.session_id)
        .map_err(store_err)?;
    let last_turn = state
        .store
        .last_turn_outcome(&input.session_id)
        .map_err(store_err)?;
    let latest_turn_timing = state
        .store
        .latest_turn_timing(&input.session_id)
        .map_err(store_err)?;
    let cursor = journal.cursor();
    // Keep the snapshot/cursor barrier, but release it before logging or
    // building the response so new task events can proceed immediately.
    drop(journal);
    let message_count = history.messages.len();
    let tool_call_count = history.tool_calls.len();
    let response = json!({
        "canAcknowledgeFailure": true,
        "eventCursor": cursor,
        "session": session,
        "lastTurn": last_turn,
        "latestTurnTiming": latest_turn_timing,
        "messages": history.messages,
        "toolCalls": history.tool_calls,
        "nextCursor": history.next_cursor,
        "processSummaries": history.process_summaries,
        "historyVersion": 1,
        "artifacts": artifacts,
        "plan": plan,
        "turnPlans": turn_plans,
        "queue": queue,
        "approvals": approvals,
        "questions": questions,
        "streamingText": streaming_text,
        "turnProgress": turn_progress,
        "goal": goal,
        "fork": fork,
    });
    tracing::info!(
        target: "miniq.perf",
        operation = "session.open",
        session_id = %input.session_id,
        history_limit = input.limit,
        message_count,
        tool_call_count,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "session open completed"
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageParams {
    session_id: String,
    message: IncomingMessage,
    #[serde(default)]
    reject_if_busy: bool,
    /// Optional model-step budget for the turn started by this message.
    #[serde(default)]
    max_turns: Option<usize>,
}

/// Upper bound for `maxTurns`; larger budgets are indistinguishable from none.
const MAX_TURN_STEPS: usize = 1_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingMessage {
    role: String,
    content: String,
    #[serde(default)]
    attachments: Vec<String>,
}

pub(super) async fn send_message(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SendMessageParams = params(raw)?;
    if input
        .max_turns
        .is_some_and(|max| max == 0 || max > MAX_TURN_STEPS)
    {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("maxTurns must be between 1 and {MAX_TURN_STEPS}"),
        ));
    }
    let attachments = validate_message(state, &input.session_id, &input.message)?;
    let content = input.message.content.trim().to_string();
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let submission = state.prompt_submissions.register(&input.session_id);
    let mut admission = submission.commit(|| {
        Ok(admission::PromptAdmission::reserve(
            state,
            &input.session_id,
        ))
    })?;
    if admission.is_none() && input.reject_if_busy {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session is already running; watch it or wait before sending",
        ));
    }
    // A guarded rejection runs no hook. An admitted prompt reserves the slot
    // while hooks run, so a concurrent stop also cancels this preparation.
    if let Some(turn) = &admission {
        tokio::select! {
            biased;
            _ = submission.token().cancelled() => return Err(prompt_cancelled()),
            _ = turn.token().cancelled() => return Err(prompt_cancelled()),
            result = user_prompt_submit_hooks(state, &input.session_id, &content) => result?,
        }
    } else {
        tokio::select! {
            biased;
            _ = submission.token().cancelled() => return Err(prompt_cancelled()),
            result = user_prompt_submit_hooks(state, &input.session_id, &content) => result?,
        }
    }
    submission.commit(|| {
        // A request that began before daemon shutdown must not admit fresh work.
        let _activity = state.activity.enter()?;
        if admission.is_none() {
            admission = admission::PromptAdmission::reserve(state, &input.session_id);
        }
        if admission.is_none() {
            if input.max_turns.is_some() {
                return Err(RpcError::new(ErrorCode::InvalidParams,
                    "maxTurns cannot be retained for queued messages; wait for this session to finish or remove maxTurns before queueing"));
            }
            let queued = state
                .store
                .enqueue_message_with_attachments(&input.session_id, &content, attachments.items())
                .map_err(store_err)?;
            attachments.commit();
            emit_queue_changed(state, &input.session_id);
            // The old turn may have released its slot between our busy check
            // and persistence. Whichever side wins admission drains the queue.
            crate::turn::start_next_queued(state, &input.session_id);
            return to_value(json!({ "queued": queued }));
        }
        if admission
            .as_ref()
            .expect("reserved prompt")
            .token()
            .is_cancelled()
        {
            return Err(prompt_cancelled());
        }
        let message = append_user_message(state, &input.session_id, &content, attachments.items())?;
        attachments.commit();
        state.emit(Event::MessageCreated {
            session_id: input.session_id.clone(),
            message: message.clone(),
        });
        set_running(state, &input.session_id)?;
        state.clear_paused_turn(&input.session_id);
        crate::session_titles::spawn(state, &input.session_id);
        state.set_turn_step_limit(&input.session_id, input.max_turns);
        let turn = admission.take().expect("reserved prompt");
        crate::turn::spawn_turn(state.clone(), input.session_id.clone(), turn.start());
        to_value(json!({ "message": message }))
    })
}

fn prompt_cancelled() -> RpcError {
    RpcError::new(
        ErrorCode::Cancelled,
        "prompt cancelled before its task started",
    )
}

async fn user_prompt_submit_hooks(
    state: &AppState,
    session_id: &str,
    prompt: &str,
) -> Result<(), RpcError> {
    use crate::hooks::{self, HookEvent};
    if hooks::configured(state, HookEvent::UserPromptSubmit, None).is_empty() {
        return Ok(());
    }
    let Some(context) = hooks::HookContext::for_session(state, session_id) else {
        return Ok(());
    };
    let payload = hooks::HookPayload {
        prompt: Some(prompt.to_string()),
        ..Default::default()
    };
    let outcome = hooks::run_event(state, &context, HookEvent::UserPromptSubmit, payload).await;
    match outcome.blocked {
        Some(reason) => Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("Blocked by userPromptSubmit hook: {reason}"),
        )),
        None => Ok(()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteMessageParams {
    session_id: String,
    message_id: String,
    message: IncomingMessage,
}

/// How long a rewrite waits for a turn the user just stopped to wind down.
const STOPPING_TURN_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

pub(super) async fn rewrite_message(
    state: &AppState,
    raw: Option<Value>,
) -> Result<Value, RpcError> {
    let input: RewriteMessageParams = params(raw)?;
    let attachments = validate_message(state, &input.session_id, &input.message)?;
    let content = input.message.content.trim().to_string();
    state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    // Editing while a task runs is "stop, then rewrite": a turn that was
    // already cancelled is awaited instead of rejected as busy.
    let submission = state.prompt_submissions.register(&input.session_id);
    let mut admission = submission.commit(|| {
        Ok(admission::PromptAdmission::reserve(
            state,
            &input.session_id,
        ))
    })?;
    if admission.is_none()
        && state
            .wait_for_cancelled_turn(&input.session_id, STOPPING_TURN_WAIT)
            .await
    {
        admission = submission.commit(|| {
            Ok(admission::PromptAdmission::reserve(
                state,
                &input.session_id,
            ))
        })?;
    }
    if admission.is_none() {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "session already has an active turn",
        ));
    }

    submission.commit(|| {
        let _activity = state.activity.enter()?;
        if admission
            .as_ref()
            .expect("reserved rewrite")
            .token()
            .is_cancelled()
        {
            return Err(prompt_cancelled());
        }
        let rewrite = state
            .store
            .rewrite_session_from_user_message(
                &input.session_id,
                &input.message_id,
                &content,
                attachments.items(),
            )
            .map_err(store_err)?;
        attachments.commit();
        state.emit(Event::SessionRewritten {
            session_id: input.session_id.clone(),
            message: rewrite.message.clone(),
            removed_message_ids: rewrite.removed_message_ids,
            removed_tool_call_ids: rewrite.removed_tool_call_ids,
            removed_artifact_ids: rewrite.removed_artifact_ids,
        });
        emit_queue_changed(state, &input.session_id);
        set_running(state, &input.session_id)?;
        state.clear_paused_turn(&input.session_id);
        crate::session_titles::spawn(state, &input.session_id);
        let turn = admission.take().expect("rewrite owns its turn slot");
        crate::turn::spawn_turn(state.clone(), input.session_id.clone(), turn.start());
        to_value(json!({ "message": rewrite.message }))
    })
}

use super::session_queue::emit_queue_changed;

const MAX_ATTACHMENTS: usize = 10;

fn validate_message(
    state: &AppState,
    session_id: &str,
    message: &IncomingMessage,
) -> Result<attachments::PreparedAttachments, RpcError> {
    if message.role != "user" {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "only user messages can be sent",
        ));
    }
    if message.content.trim().is_empty() && message.attachments.is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "message content is empty",
        ));
    }
    if message.attachments.len() > MAX_ATTACHMENTS {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("一次最多附加 {MAX_ATTACHMENTS} 个文件"),
        ));
    }
    attachments::prepare(
        &message.attachments,
        &state.observations_dir.join("attachments"),
        &workspace_roots(state, session_id)?,
    )
}

/// Roots whose files the session can already open by path, so their attachments
/// never need a durable copy of their own.
fn workspace_roots(
    state: &AppState,
    session_id: &str,
) -> Result<Vec<std::path::PathBuf>, RpcError> {
    let session = state.store.get_session(session_id).map_err(store_err)?;
    let workspace = state
        .store
        .get_workspace(&session.workspace_id)
        .map_err(store_err)?;
    Ok(std::iter::once(workspace.path)
        .chain(workspace.additional_paths)
        .map(std::path::PathBuf::from)
        .collect())
}

fn append_user_message(
    state: &AppState,
    session_id: &str,
    content: &str,
    attachments: &[MessageAttachment],
) -> Result<miniq_protocol::Message, RpcError> {
    let message = state
        .store
        .append_message_with_attachments(session_id, Role::User, content, attachments)
        .map_err(store_err)?;

    Ok(message)
}

fn set_running(state: &AppState, session_id: &str) -> Result<(), RpcError> {
    state
        .store
        .update_session_status(session_id, SessionStatus::Running)
        .map_err(store_err)?;
    state.emit(Event::SessionStatusChanged {
        session_id: session_id.to_string(),
        status: SessionStatus::Running,
    });
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    session_id: String,
}

pub(super) fn pause(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CancelParams = params(raw)?;
    state.prompt_submissions.synchronize(|| {
        let session = state
            .store
            .get_session(&input.session_id)
            .map_err(store_err)?;
        if !matches!(
            session.status,
            SessionStatus::Running | SessionStatus::WaitingApproval
        ) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "session does not have a running task to pause; a pending prompt can be cancelled",
            ));
        }
        if !state.pause_turn(&input.session_id) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "session does not have an active turn",
            ));
        }
        Ok(json!({ "paused": true }))
    })
}

pub(super) fn resume(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CancelParams = params(raw)?;
    state.prompt_submissions.synchronize(|| {
        let runtime_paused = state.is_turn_paused(&input.session_id);
        if state.has_active_turn(&input.session_id) {
            if !runtime_paused {
                return Err(RpcError::new(ErrorCode::InvalidParams,
                    "the active task is not paused"));
            }
            transition_paused_goal(state, &input.session_id, SessionGoalStatus::Active)?;
            state.request_turn_resume(&input.session_id);
            return Ok(json!({ "resumed": true, "pending": true }));
        }
        let paused_goal = state
            .store
            .session_goal(&input.session_id)
            .map_err(store_err)?
            .is_some_and(|goal| goal.status == SessionGoalStatus::Paused);
        let paused_outcome = state
            .store
            .last_turn_outcome(&input.session_id)
            .map_err(store_err)?
            .is_some_and(|outcome| outcome["status"] == "paused");
        if !runtime_paused && !paused_goal && !paused_outcome {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "session does not have a paused turn",
            ));
        }
        let Some(cancel) = state.begin_turn(&input.session_id) else {
            return Err(RpcError::new(ErrorCode::SessionBusy,
                "session cannot resume while another prompt is preparing or the daemon is shutting down"));
        };
        if let Err(error) = transition_paused_goal(state, &input.session_id, SessionGoalStatus::Active) {
            state.end_turn(&input.session_id);
            return Err(error);
        }
        state.resume_turn(&input.session_id);
        state.take_turn_resume_request(&input.session_id);
        if let Err(error) = set_running(state, &input.session_id) {
            state.end_turn(&input.session_id);
            return Err(error);
        }
        crate::turn::spawn_turn(state.clone(), input.session_id, cancel);
        Ok(json!({ "resumed": true }))
    })
}

fn transition_paused_goal(
    state: &AppState,
    session_id: &str,
    status: SessionGoalStatus,
) -> Result<bool, RpcError> {
    let Some(goal) = state.store.session_goal(session_id).map_err(store_err)? else {
        return Ok(false);
    };
    if goal.status != SessionGoalStatus::Paused {
        return Ok(false);
    }
    let goal = state
        .store
        .update_session_goal(&miniq_protocol::SessionGoalUpdate {
            session_id: session_id.to_owned(),
            goal: goal.goal,
            status,
            token_budget: goal.token_budget,
        })
        .map_err(store_err)?;
    state.emit(Event::SessionGoalChanged {
        session_id: session_id.to_owned(),
        goal: Some(goal),
    });
    Ok(true)
}

fn cancel_paused_turn(state: &AppState, session_id: &str) -> Result<bool, RpcError> {
    let paused_outcome = state
        .store
        .last_turn_outcome(session_id)
        .map_err(store_err)?
        .is_some_and(|outcome| outcome["status"] == "paused");
    let paused_goal = transition_paused_goal(state, session_id, SessionGoalStatus::Cancelled)?;
    if paused_outcome {
        state
            .store
            .record_turn_outcome(session_id, "cancelled", Some("cancelled"))
            .map_err(store_err)?;
    }
    Ok(state.clear_paused_turn(session_id) || paused_outcome || paused_goal)
}

pub(super) async fn cancel(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CancelParams = params(raw)?;
    let (cancelled_prompts, stopped) = state.prompt_submissions.cancel(&input.session_id, || {
        // An explicit stop discards queued follow-ups too: the user wants the
        // session to come to rest, not to start the next queued message.
        let cleared = state
            .store
            .clear_queued_messages(&input.session_id)
            .map_err(store_err)?;
        if cleared > 0 {
            emit_queue_changed(state, &input.session_id);
        }
        let was_paused = cancel_paused_turn(state, &input.session_id)?;
        let cancelled = state.cancel_turn(&input.session_id);
        let recovered = if cancelled {
            let _ = state
                .store
                .update_session_status(&input.session_id, SessionStatus::Cancelling);
            state.emit(Event::SessionStatusChanged {
                session_id: input.session_id.clone(),
                status: SessionStatus::Cancelling,
            });
            false
        } else if was_paused {
            false
        } else {
            let recovery = state
                .store
                .recover_interrupted_session(&input.session_id)
                .map_err(store_err)?;
            if recovery.session_failed {
                state.emit(Event::SessionStatusChanged {
                    session_id: input.session_id.clone(),
                    status: SessionStatus::Failed,
                });
            }
            recovery.session_failed
        };
        Ok::<_, RpcError>((was_paused, cancelled, recovered))
    });
    let (was_paused, cancelled, recovered) = stopped?;
    let cancelled_agents = state.agent_tasks.cancel_session(&input.session_id).await;
    if cancelled
        && !state
            .wait_for_cancelled_turn(&input.session_id, STOPPING_TURN_WAIT)
            .await
    {
        return Err(RpcError::new(ErrorCode::SessionBusy,
            "cancellation was requested but the task has not confirmed it stopped; watch the session before sending again"));
    }
    Ok(
        json!({ "cancelled": cancelled_prompts || was_paused || cancelled || recovered || cancelled_agents > 0 }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameParams {
    session_id: String,
    title: String,
}

pub(super) fn rename(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: RenameParams = params(raw)?;
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "title cannot be empty",
        ));
    }
    state
        .store
        .update_session_title(&input.session_id, &title)
        .map_err(store_err)?;
    state.emit(Event::SessionRenamed {
        session_id: input.session_id.clone(),
        title: title.clone(),
    });
    Ok(json!({ "id": input.session_id, "title": title }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPinnedParams {
    session_id: String,
    pinned: bool,
}

pub(super) fn set_pinned(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SetPinnedParams = params(raw)?;
    state
        .store
        .set_session_pinned(&input.session_id, input.pinned)
        .map_err(store_err)?;
    state.emit(Event::SessionPinnedChanged {
        session_id: input.session_id.clone(),
        pinned: input.pinned,
    });
    Ok(json!({ "id": input.session_id, "pinned": input.pinned }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

/// Full-text search across message contents. Returns the latest matching
/// message per session so the UI can jump straight into the conversation.
pub(super) fn search(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SearchParams = params(raw)?;
    let query = input.query.trim();
    if query.is_empty() {
        return to_value(json!({ "matches": [] }));
    }
    let limit = input.limit.unwrap_or(20).min(100);
    let matches = state
        .store
        .search_messages(query, limit)
        .map_err(store_err)?;
    to_value(json!({ "matches": matches }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetArchivedParams {
    session_id: String,
    archived: bool,
}

pub(super) fn set_archived(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SetArchivedParams = params(raw)?;
    state
        .store
        .set_session_archived(&input.session_id, input.archived)
        .map_err(store_err)?;
    state.emit(Event::SessionArchivedChanged {
        session_id: input.session_id.clone(),
        archived: input.archived,
    });
    Ok(json!({ "id": input.session_id, "archived": input.archived }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteParams {
    session_id: String,
}

pub(super) fn delete(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DeleteParams = params(raw)?;
    // Refuse to delete a running session.
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    if session.status == SessionStatus::Running || session.status == SessionStatus::Cancelling {
        return Err(RpcError::new(
            ErrorCode::SessionBusy,
            "cannot delete a running session",
        ));
    }
    state
        .store
        .delete_session(&input.session_id)
        .map_err(store_err)?;
    state.emit(Event::SessionDeleted {
        session_id: input.session_id,
    });
    Ok(json!({ "deleted": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_memory::Store;
    use miniq_models::mock::MockProvider;
    use miniq_protocol::SessionGoalUpdate;
    use std::sync::Arc;

    fn setup() -> (AppState, String) {
        let store = Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp", "test").unwrap();
        let session_id = store.create_session(&workspace.id, "chat").unwrap().id;
        (
            AppState::new(
                store,
                "test-only".into(),
                Arc::new(MockProvider::text("new answer")),
            ),
            session_id,
        )
    }

    #[test]
    fn open_restores_failure_reason_after_database_reopen_and_acknowledgement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.db");
        let store = Store::open(&path).unwrap();
        let workspace = store.create_workspace("/tmp", "test").unwrap();
        let session = store.create_session(&workspace.id, "failed").unwrap();
        let user = store
            .append_message(&session.id, Role::User, "task")
            .unwrap();
        let reason = "provider error: The request timed out while trying to download the file";
        store
            .record_turn_outcome(&session.id, "failed", Some(reason))
            .unwrap();
        store
            .update_session_status(&session.id, SessionStatus::Failed)
            .unwrap();
        drop(store);

        let state = AppState::new(
            Store::open(&path).unwrap(),
            "test-only".into(),
            Arc::new(MockProvider::text("unused")),
        );
        let params = || Some(json!({"sessionId":session.id,"view":"visible","limit":1}));
        let opened = open(&state, params()).unwrap();
        assert_eq!(
            opened["lastTurn"],
            json!({
                "anchorMessageId":user.id,"status":"failed","error":reason
            })
        );
        assert_eq!(opened["session"]["status"], "failed");
        state
            .store
            .acknowledge_session_failure(
                &session.id,
                opened["session"]["updatedAt"].as_str().unwrap(),
            )
            .unwrap();
        let acknowledged = open(&state, params()).unwrap();
        assert_eq!(acknowledged["session"]["status"], "idle");
        assert_eq!(acknowledged["lastTurn"], opened["lastTurn"]);
    }

    fn rewrite_params(session_id: &str, message_id: &str, content: &str) -> Option<Value> {
        Some(json!({
            "sessionId": session_id,
            "messageId": message_id,
            "message": {"role": "user", "content": content},
        }))
    }

    #[tokio::test]
    async fn rewrite_replaces_the_old_branch_and_starts_a_turn() {
        let (state, session_id) = setup();
        let user = state
            .store
            .append_message(&session_id, Role::User, "old question")
            .unwrap();
        let old_answer = state
            .store
            .append_message(&session_id, Role::Assistant, "old answer")
            .unwrap();
        state
            .store
            .enqueue_message(&session_id, "old queued")
            .unwrap();
        let mut events = state.events.subscribe();

        let response = rewrite_message(
            &state,
            rewrite_params(&session_id, &user.id, "new question"),
        )
        .await
        .unwrap();

        assert_eq!(response["message"]["id"], user.id);
        assert_eq!(response["message"]["content"], "new question");
        assert!(matches!(
            events.try_recv().unwrap(),
            Event::SessionRewritten { message, removed_message_ids, .. }
                if message.id == user.id && removed_message_ids == vec![old_answer.id]
        ));
        assert!(matches!(
            events.try_recv().unwrap(),
            Event::QueueChanged { queue, .. } if queue.is_empty()
        ));
        assert!(matches!(
            events.try_recv().unwrap(),
            Event::SessionStatusChanged {
                status: SessionStatus::Running,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn rewrite_rejects_busy_sessions_without_changing_history() {
        let (state, session_id) = setup();
        let user = state
            .store
            .append_message(&session_id, Role::User, "old question")
            .unwrap();
        let _active_turn = state.begin_turn(&session_id).unwrap();

        let error = rewrite_message(
            &state,
            rewrite_params(&session_id, &user.id, "new question"),
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::SessionBusy as i64);
        assert_eq!(
            state.store.list_messages(&session_id).unwrap()[0].content,
            "old question"
        );
        state.end_turn(&session_id);
    }

    #[tokio::test]
    async fn rewrite_waits_for_a_stopped_turn_to_release_its_slot() {
        let (state, session_id) = setup();
        let user = state
            .store
            .append_message(&session_id, Role::User, "old question")
            .unwrap();
        state.begin_turn(&session_id).unwrap();
        assert!(state.cancel_turn(&session_id));
        let ending = state.clone();
        let ending_session = session_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            ending.end_turn(&ending_session);
        });

        let response = rewrite_message(
            &state,
            rewrite_params(&session_id, &user.id, "edited while running"),
        )
        .await
        .unwrap();

        assert_eq!(response["message"]["content"], "edited while running");
        assert!(state.has_active_turn(&session_id));
    }

    #[tokio::test]
    async fn rewrite_releases_the_turn_slot_when_the_anchor_is_not_a_user_message() {
        let (state, session_id) = setup();
        let assistant = state
            .store
            .append_message(&session_id, Role::Assistant, "answer")
            .unwrap();

        rewrite_message(
            &state,
            rewrite_params(&session_id, &assistant.id, "new question"),
        )
        .await
        .unwrap_err();

        assert!(state.begin_turn(&session_id).is_some());
        assert_eq!(
            state.store.list_messages(&session_id).unwrap()[0].content,
            "answer"
        );
        state.end_turn(&session_id);
    }

    #[tokio::test]
    async fn resume_accepts_persisted_pause_after_runtime_state_is_lost() {
        let (state, session_id) = setup();
        state
            .store
            .update_session_goal(&SessionGoalUpdate {
                session_id: session_id.clone(),
                goal: "finish the task".into(),
                status: SessionGoalStatus::Paused,
                token_budget: None,
            })
            .unwrap();
        let response = resume(&state, Some(json!({ "sessionId": session_id }))).unwrap();

        assert_eq!(response, json!({ "resumed": true }));
        assert!(!state.take_turn_resume_request(&session_id));
        assert_eq!(
            state
                .store
                .session_goal(&session_id)
                .unwrap()
                .unwrap()
                .status,
            SessionGoalStatus::Active
        );
    }
}
