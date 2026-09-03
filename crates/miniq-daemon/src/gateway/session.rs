use miniq_protocol::{ErrorCode, Event, ImageAttachment, Role, RpcError, SessionStatus};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err, to_value};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    workspace_id: String,
    #[serde(default)]
    title: Option<String>,
}

pub(super) fn create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CreateParams = params(raw)?;
    state
        .store
        .get_workspace(&input.workspace_id)
        .map_err(store_err)?;
    let title = input.title.unwrap_or_else(|| "New session".to_string());
    let session = state
        .store
        .create_session(&input.workspace_id, &title)
        .map_err(store_err)?;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    session_id: String,
}

pub(super) fn open(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: OpenParams = params(raw)?;
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;
    let messages = state
        .store
        .list_messages(&input.session_id)
        .map_err(store_err)?;
    let tool_calls = state
        .store
        .list_tool_calls(&input.session_id)
        .map_err(store_err)?;
    let artifacts = state
        .store
        .list_artifacts(&input.session_id)
        .map_err(store_err)?;
    let plan = state
        .plans
        .lock()
        .unwrap()
        .get(&input.session_id)
        .cloned()
        .unwrap_or_default();
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
    to_value(json!({
        "session": session,
        "messages": messages,
        "toolCalls": tool_calls,
        "artifacts": artifacts,
        "plan": plan,
        "queue": queue,
        "approvals": approvals,
        "questions": questions,
        "streamingText": streaming_text,
        "turnProgress": turn_progress,
    }))
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
    #[serde(default)]
    images: Vec<ImageAttachment>,
}

pub(super) fn send_message(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SendMessageParams = params(raw)?;
    validate_message(&input.message)?;
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;

    let Some(cancel) = state.begin_turn(&input.session_id) else {
        // The session already has an active turn: queue the message instead of
        // rejecting it. It will run automatically when the current turn ends.
        let queued = state
            .store
            .enqueue_message(
                &input.session_id,
                &input.message.content,
                &input.message.images,
            )
            .map_err(store_err)?;
        emit_queue_changed(state, &input.session_id);
        return to_value(json!({ "queued": queued }));
    };

    let message = append_user_message(state, &input, &session.title)?;
    state.emit(Event::MessageCreated {
        session_id: input.session_id.clone(),
        message: message.clone(),
    });
    set_running(state, &input.session_id)?;
    crate::turn::spawn_turn(state.clone(), input.session_id, cancel);
    to_value(json!({ "message": message }))
}

pub(super) fn emit_queue_changed(state: &AppState, session_id: &str) {
    let queue = state
        .store
        .list_queued_messages(session_id)
        .unwrap_or_default();
    state.emit(Event::QueueChanged {
        session_id: session_id.to_string(),
        queue,
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueListParams {
    session_id: String,
}

pub(super) fn queue_list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QueueListParams = params(raw)?;
    let queue = state
        .store
        .list_queued_messages(&input.session_id)
        .map_err(store_err)?;
    to_value(json!({ "queue": queue }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueItemParams {
    queued_message_id: String,
}

pub(super) fn queue_remove(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QueueItemParams = params(raw)?;
    let removed = state
        .store
        .remove_queued_message(&input.queued_message_id)
        .map_err(store_err)?;
    emit_queue_changed(state, &removed.session_id);
    to_value(json!({ "removed": removed }))
}

/// "调整方向": move a queued message to the front and interrupt the running
/// turn so it executes immediately. The turn-end drain picks it up.
pub(super) fn queue_steer(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: QueueItemParams = params(raw)?;
    let promoted = state
        .store
        .promote_queued_message(&input.queued_message_id)
        .map_err(store_err)?;
    emit_queue_changed(state, &promoted.session_id);
    let interrupted = state.cancel_turn(&promoted.session_id);
    if interrupted {
        let _ = state
            .store
            .update_session_status(&promoted.session_id, SessionStatus::Cancelling);
        state.emit(Event::SessionStatusChanged {
            session_id: promoted.session_id.clone(),
            status: SessionStatus::Cancelling,
        });
    }
    to_value(json!({ "promoted": promoted, "interrupted": interrupted }))
}

fn validate_message(message: &IncomingMessage) -> Result<(), RpcError> {
    if message.role != "user" {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "only user messages can be sent",
        ));
    }
    if message.content.trim().is_empty() && message.images.is_empty() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "message content is empty",
        ));
    }
    if message.images.len() > 4 {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "a message can contain at most 4 images",
        ));
    }
    for image in &message.images {
        if !matches!(
            image.media_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "unsupported image type",
            ));
        }
        if image.data.is_empty() || image.data.len() > 14_000_000 {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "image data is empty or exceeds 10 MiB",
            ));
        }
    }
    Ok(())
}

fn append_user_message(
    state: &AppState,
    input: &SendMessageParams,
    current_title: &str,
) -> Result<miniq_protocol::Message, RpcError> {
    let message = state
        .store
        .append_message_with_images(
            &input.session_id,
            Role::User,
            &input.message.content,
            &input.message.images,
        )
        .map_err(|error| {
            state.end_turn(&input.session_id);
            store_err(error)
        })?;

    if current_title == "New session" {
        let title: String = if input.message.content.trim().is_empty() {
            "图片问答".to_string()
        } else {
            input.message.content.trim().chars().take(30).collect()
        };
        if !title.is_empty() {
            let _ = state.store.update_session_title(&input.session_id, &title);
        }
    }
    Ok(message)
}

fn set_running(state: &AppState, session_id: &str) -> Result<(), RpcError> {
    state
        .store
        .update_session_status(session_id, SessionStatus::Running)
        .map_err(|error| {
            state.end_turn(session_id);
            store_err(error)
        })?;
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

pub(super) fn cancel(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: CancelParams = params(raw)?;
    // An explicit stop discards queued follow-ups too: the user wants the
    // session to come to rest, not to start the next queued message.
    let cleared = state
        .store
        .clear_queued_messages(&input.session_id)
        .unwrap_or(0);
    if cleared > 0 {
        emit_queue_changed(state, &input.session_id);
    }
    let cancelled = state.cancel_turn(&input.session_id);
    if cancelled {
        let _ = state
            .store
            .update_session_status(&input.session_id, SessionStatus::Cancelling);
        state.emit(Event::SessionStatusChanged {
            session_id: input.session_id,
            status: SessionStatus::Cancelling,
        });
    }
    Ok(json!({ "cancelled": cancelled }))
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
