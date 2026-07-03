//! One agent turn: persist the user message, stream the model, persist the
//! assistant reply and emit protocol events along the way.

use miniq_agent::{run_turn, AgentError, AgentEvent};
use miniq_models::{ChatMessage, ChatRole};
use miniq_protocol::{Event, Message, Role, SessionStatus};
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

const SYSTEM_PROMPT: &str = "You are miniQ, a local coding copilot that collaborates with the \
user inside their workspace. Be concise and accurate.";

/// Build the provider-facing history from persisted messages.
fn history_from_messages(messages: &[Message]) -> Vec<ChatMessage> {
    let mut history = vec![ChatMessage::system(SYSTEM_PROMPT)];
    for msg in messages {
        let role = match msg.role {
            Role::User => ChatRole::User,
            Role::Assistant => ChatRole::Assistant,
            Role::System => ChatRole::System,
            // Tool transcripts are not replayed into later turns for now.
            Role::Tool => continue,
        };
        history.push(ChatMessage {
            role,
            content: msg.content.clone(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        });
    }
    history
}

/// Run a full turn in a background task. Assumes the user message is already
/// persisted and the turn slot is registered in `state.active_turns`.
pub fn spawn_turn(state: AppState, session_id: String, cancel: CancellationToken) {
    tokio::spawn(async move {
        let result = execute_turn(&state, &session_id, cancel).await;
        state.end_turn(&session_id);
        match result {
            Ok(()) => {
                let _ = state.store.update_session_status(&session_id, SessionStatus::Idle);
                state.emit(Event::SessionStatusChanged {
                    session_id: session_id.clone(),
                    status: SessionStatus::Idle,
                });
                state.emit(Event::TurnCompleted {
                    session_id: session_id.clone(),
                });
            }
            Err(TurnError::Cancelled) => {
                let _ = state.store.update_session_status(&session_id, SessionStatus::Idle);
                state.emit(Event::SessionStatusChanged {
                    session_id: session_id.clone(),
                    status: SessionStatus::Idle,
                });
                state.emit(Event::TurnFailed {
                    session_id: session_id.clone(),
                    error: "cancelled".to_string(),
                });
            }
            Err(TurnError::Fatal(err)) => {
                tracing::error!(session_id, %err, "turn failed");
                let _ = state
                    .store
                    .update_session_status(&session_id, SessionStatus::Failed);
                state.emit(Event::SessionStatusChanged {
                    session_id: session_id.clone(),
                    status: SessionStatus::Failed,
                });
                state.emit(Event::TurnFailed {
                    session_id: session_id.clone(),
                    error: err,
                });
            }
        }
    });
}

enum TurnError {
    Cancelled,
    Fatal(String),
}

async fn execute_turn(
    state: &AppState,
    session_id: &str,
    cancel: CancellationToken,
) -> Result<(), TurnError> {
    let messages = state
        .store
        .list_messages(session_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    let history = history_from_messages(&messages);

    // Allocate the assistant message id upfront so streaming deltas can
    // reference it before the row is written.
    let message_id = miniq_memory::new_id("msg");
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<AgentEvent>(64);

    // Forward agent text deltas as protocol events while the turn runs.
    let forward_state = state.clone();
    let forward_session = session_id.to_string();
    let forward_message_id = message_id.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                AgentEvent::TextDelta(delta) => forward_state.emit(Event::AssistantDelta {
                    session_id: forward_session.clone(),
                    message_id: forward_message_id.clone(),
                    delta,
                }),
            }
        }
    });

    // Resolve the workspace for tool containment.
    let session = state
        .store
        .get_session(session_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    let workspace = state
        .store
        .get_workspace(&session.workspace_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;

    let executor = crate::executor::SessionToolExecutor {
        state: state.clone(),
        session_id: session_id.to_string(),
        router: state.router.clone(),
        ctx: miniq_tools::ToolContext {
            workspace: std::path::PathBuf::from(&workspace.path),
        },
        cancel: cancel.clone(),
    };

    let provider = state.current_provider();
    let outcome = run_turn(provider.as_ref(), &executor, history, event_tx, cancel).await;
    let _ = forwarder.await;

    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(AgentError::Cancelled) => return Err(TurnError::Cancelled),
        Err(e) => return Err(TurnError::Fatal(e.to_string())),
    };

    let message = state
        .store
        .append_message_with_id(&message_id, session_id, Role::Assistant, &outcome.final_text)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    state.emit(Event::MessageCreated {
        session_id: session_id.to_string(),
        message,
    });
    Ok(())
}
