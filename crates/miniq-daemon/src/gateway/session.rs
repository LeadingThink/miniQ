use miniq_protocol::{ErrorCode, Event, MessageAttachment, Role, RpcError, SessionStatus};
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
    attachments: Vec<String>,
}

pub(super) fn send_message(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SendMessageParams = params(raw)?;
    let attachments = validate_message(&input.message)?;
    let content = display_content(&input.message.content, &attachments);
    let session = state
        .store
        .get_session(&input.session_id)
        .map_err(store_err)?;

    let Some(cancel) = state.begin_turn(&input.session_id) else {
        // The session already has an active turn: queue the message instead of
        // rejecting it. It will run automatically when the current turn ends.
        let queued = state
            .store
            .enqueue_message_with_attachments(&input.session_id, &content, &attachments)
            .map_err(store_err)?;
        emit_queue_changed(state, &input.session_id);
        return to_value(json!({ "queued": queued }));
    };

    let message = append_user_message(
        state,
        &input.session_id,
        &content,
        &attachments,
        &session.title,
    )?;
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

const MAX_ATTACHMENTS: usize = 10;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

fn validate_message(message: &IncomingMessage) -> Result<Vec<MessageAttachment>, RpcError> {
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
    message
        .attachments
        .iter()
        .map(|path| validate_attachment(path))
        .collect()
}

fn validate_attachment(path: &str) -> Result<MessageAttachment, RpcError> {
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("无法读取附件 {path}: {error}"),
        )
    })?;
    let metadata = canonical.metadata().map_err(|error| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("无法读取附件 {}: {error}", canonical.display()),
        )
    })?;
    if !metadata.is_file() {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("附件不是文件: {}", canonical.display()),
        ));
    }
    let mime_type = image_mime_type(&canonical).map(str::to_string);
    if mime_type.is_some() && metadata.len() > MAX_IMAGE_BYTES {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            format!("图片附件不能超过 20 MB: {}", canonical.display()),
        ));
    }
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();
    Ok(MessageAttachment {
        path: canonical.to_string_lossy().into_owned(),
        name,
        mime_type,
    })
}

fn image_mime_type(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn display_content(content: &str, attachments: &[MessageAttachment]) -> String {
    let content = content.trim();
    if attachments.is_empty() {
        return content.to_string();
    }
    let files = attachments
        .iter()
        .map(|attachment| format!("- {}", attachment.path))
        .collect::<Vec<_>>()
        .join("\n");
    let block = format!("[用户附加的本地文件]\n{files}");
    if content.is_empty() {
        block
    } else {
        format!("{content}\n\n{block}")
    }
}

fn append_user_message(
    state: &AppState,
    session_id: &str,
    content: &str,
    attachments: &[MessageAttachment],
    current_title: &str,
) -> Result<miniq_protocol::Message, RpcError> {
    let message = state
        .store
        .append_message_with_attachments(session_id, Role::User, content, attachments)
        .map_err(|error| {
            state.end_turn(session_id);
            store_err(error)
        })?;

    if current_title == "New session" {
        let title: String = content.trim().chars().take(30).collect();
        if !title.is_empty() {
            let _ = state.store.update_session_title(session_id, &title);
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
    let recovered = if cancelled {
        let _ = state
            .store
            .update_session_status(&input.session_id, SessionStatus::Cancelling);
        state.emit(Event::SessionStatusChanged {
            session_id: input.session_id.clone(),
            status: SessionStatus::Cancelling,
        });
        false
    } else {
        let recovery = state
            .store
            .recover_interrupted_session(&input.session_id)
            .map_err(store_err)?;
        if recovery.session_failed {
            state.emit(Event::SessionStatusChanged {
                session_id: input.session_id,
                status: SessionStatus::Failed,
            });
        }
        recovery.session_failed
    };
    Ok(json!({ "cancelled": cancelled || recovered }))
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
