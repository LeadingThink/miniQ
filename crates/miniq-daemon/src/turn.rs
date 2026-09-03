//! One agent turn: persist the user message, stream the model, persist the
//! assistant reply and emit protocol events along the way.

use miniq_agent::{run_turn, AgentError, AgentEvent};
use miniq_models::{ChatMessage, ChatRole, ImageAttachment};
use miniq_protocol::{Event, Message, Role, SessionStatus, TurnPhase};
use std::path::Path;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

const SYSTEM_PROMPT: &str = "You are miniQ, a local AI coworker that collaborates with the \
user inside their workspace: you plan multi-step tasks, read and edit files, run commands \
and deliver ready-to-use results. Be concise and accurate. High-risk actions go through \
user approval; if an action is rejected, adapt instead of retrying it verbatim. Always use \
Simplified Chinese for all user-facing text, including the reasoning text emitted before each \
tool call and the final answer. Preserve code, commands, file paths, URLs, and proper nouns in \
their original form when appropriate.";

const HOST_APP_CONTEXT: &str = "Host app file references: whenever you reference a local \
workspace file in a response, use a Markdown link with a concise filename label and the \
complete absolute filesystem path as its target, for example `[filename](D:/absolute/path)` \
on Windows or `[filename](/absolute/path)` on Unix. Use forward slashes in Windows Markdown \
link targets. If a target contains spaces, wrap it in angle brackets, for example \
`[report.md](<D:/work/My Project/report.md>)`. Never abbreviate or omit any path segment, \
including with `...`. Do not use relative targets, `file://`, `vscode://`, or backticks around \
the link. When a source line matters, put it in the label, for example \
`[main.rs (line 42)](/absolute/path/main.rs)`, while keeping the target as the file path only.";

/// Build the provider-facing history from persisted messages, with runtime
/// details and available skills appended to the system prompt.
fn history_from_messages(
    messages: &[Message],
    skills_block: &str,
    workspace_path: &Path,
) -> Vec<ChatMessage> {
    let mut system = format!(
        "{SYSTEM_PROMPT}\n\n{}\n\n{HOST_APP_CONTEXT}",
        runtime_context(workspace_path)
    );
    if !skills_block.is_empty() {
        system.push_str("\n\n");
        system.push_str(skills_block);
    }
    let mut history = vec![ChatMessage::system(system)];
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
            images: msg
                .images
                .iter()
                .map(|image| ImageAttachment {
                    media_type: image.media_type.clone(),
                    data: image.data.clone(),
                })
                .collect(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        });
    }
    history
}

fn runtime_context(workspace_path: &Path) -> String {
    #[cfg(windows)]
    let platform = "Windows; shell_run executes Windows PowerShell through powershell.exe \
                    without profiles or interactive input";
    #[cfg(not(windows))]
    let platform = "a Unix-like operating system; shell_run executes POSIX sh";

    format!(
        "Runtime environment: {platform}. The workspace and command working directory is '{}'. \
         Use commands valid for this shell. Prefer native shell commands for ordinary filesystem \
         inspection; use Python when the task actually benefits from Python.",
        workspace_path.display()
    )
}

/// Run a full turn in a background task. Assumes the user message is already
/// persisted and the turn slot is registered in `state.active_turns`.
pub fn spawn_turn(state: AppState, session_id: String, cancel: CancellationToken) {
    tokio::spawn(async move {
        let result = execute_turn(&state, &session_id, cancel).await;
        state.clear_streaming_text(&session_id);
        state.clear_turn_progress(&session_id);
        state.end_turn(&session_id);
        match result {
            Ok(()) => {
                let _ = state
                    .store
                    .update_session_status(&session_id, SessionStatus::Idle);
                state.emit(Event::SessionStatusChanged {
                    session_id: session_id.clone(),
                    status: SessionStatus::Idle,
                });
                state.emit(Event::TurnCompleted {
                    session_id: session_id.clone(),
                });
            }
            Err(TurnError::Cancelled) => {
                let _ = state
                    .store
                    .update_session_status(&session_id, SessionStatus::Idle);
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
        // Queued follow-ups (sent while this turn ran, or steered to the
        // front to interrupt it) start automatically once the session rests.
        start_next_queued(&state, &session_id);
    });
}

/// If the session has queued messages, dequeue the head and start its turn.
/// No-op when another turn already claimed the session.
fn start_next_queued(state: &AppState, session_id: &str) {
    let next = match state.store.dequeue_message(session_id) {
        Ok(Some(next)) => next,
        Ok(None) => return,
        Err(err) => {
            tracing::error!(session_id, %err, "failed to read message queue");
            return;
        }
    };
    let Some(cancel) = state.begin_turn(session_id) else {
        // Session got claimed in the meantime; put the message back in front.
        if let Ok(requeued) = state
            .store
            .enqueue_message(session_id, &next.content, &next.images)
        {
            let _ = state.store.promote_queued_message(&requeued.id);
        }
        return;
    };
    crate::gateway::emit_session_queue_changed(state, session_id);
    let message = match state
        .store
        .append_message_with_images(session_id, Role::User, &next.content, &next.images)
    {
        Ok(message) => message,
        Err(err) => {
            tracing::error!(session_id, %err, "failed to persist queued message");
            state.end_turn(session_id);
            return;
        }
    };
    state.emit(Event::MessageCreated {
        session_id: session_id.to_string(),
        message,
    });
    let _ = state
        .store
        .update_session_status(session_id, SessionStatus::Running);
    state.emit(Event::SessionStatusChanged {
        session_id: session_id.to_string(),
        status: SessionStatus::Running,
    });
    spawn_turn(state.clone(), session_id.to_string(), cancel);
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
    state.clear_streaming_text(session_id);
    state.set_turn_progress(session_id, TurnPhase::PreparingContext, None);
    state.plans.lock().unwrap().remove(session_id);
    state.emit(Event::PlanUpdated {
        session_id: session_id.to_string(),
        tasks: Vec::new(),
    });
    // Resolve the workspace first: it scopes both skills and tools.
    let session = state
        .store
        .get_session(session_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    let workspace = state
        .store
        .get_workspace(&session.workspace_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    let workspace_path = std::path::PathBuf::from(&workspace.path);

    let skills = state.skills.discover(Some(&workspace_path));
    let skills_block = miniq_skills::available_skills_block(&skills);

    let messages = state
        .store
        .list_messages(session_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    let history = history_from_messages(&messages, &skills_block, &workspace_path);

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
                AgentEvent::TextDelta(delta) => {
                    forward_state.append_streaming_text(&forward_session, &delta);
                    forward_state.emit(Event::AssistantDelta {
                        session_id: forward_session.clone(),
                        message_id: forward_message_id.clone(),
                        delta,
                    });
                }
                AgentEvent::ModelRequestStarted { step } => forward_state.set_turn_progress(
                    &forward_session,
                    TurnPhase::RequestingModel,
                    Some(step),
                ),
                AgentEvent::ModelResponseStarted { step } => forward_state.set_turn_progress(
                    &forward_session,
                    TurnPhase::ReceivingModel,
                    Some(step),
                ),
            }
        }
    });

    let executor = crate::executor::SessionToolExecutor {
        state: state.clone(),
        session_id: session_id.to_string(),
        router: state.router.clone(),
        ctx: miniq_tools::ToolContext::new(workspace_path)
            .with_skills(Some(state.skills.clone()))
            .with_memory(
                Some(state.store.clone()),
                Some(session.workspace_id.clone()),
            )
            .with_mcp(state.mcp_bridge()),
        cancel: cancel.clone(),
    };

    let provider = state.current_provider();
    let outcome = run_turn(provider.as_ref(), &executor, history, event_tx, cancel).await;
    let _ = forwarder.await;

    let outcome = match outcome {
        Ok(outcome) => {
            state.set_turn_progress(session_id, TurnPhase::Finalizing, None);
            outcome
        }
        Err(AgentError::Cancelled) => return Err(TurnError::Cancelled),
        Err(e) => return Err(TurnError::Fatal(e.to_string())),
    };

    let message = state
        .store
        .append_message_with_id(
            &message_id,
            session_id,
            Role::Assistant,
            &outcome.final_text,
        )
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    state.emit(Event::MessageCreated {
        session_id: session_id.to_string(),
        message,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_includes_runtime_and_workspace() {
        let workspace = Path::new("test-workspace");
        let history = history_from_messages(&[], "", workspace);
        let system = &history[0].content;

        assert!(system.contains("Runtime environment:"));
        assert!(system.contains("test-workspace"));
        #[cfg(windows)]
        assert!(system.contains("Windows PowerShell"));
        #[cfg(not(windows))]
        assert!(system.contains("POSIX sh"));
    }

    #[test]
    fn system_prompt_requires_complete_absolute_file_links() {
        let history = history_from_messages(&[], "", Path::new("workspace"));
        let system = &history[0].content;

        assert!(system.contains("[filename](D:/absolute/path)"));
        assert!(system.contains("complete absolute filesystem path"));
        assert!(system.contains("Never abbreviate or omit any path segment"));
        assert!(system.contains("Use forward slashes in Windows Markdown link targets"));
        assert!(system.contains("[main.rs (line 42)](/absolute/path/main.rs)"));
    }

    #[test]
    fn system_prompt_requires_simplified_chinese_reasoning_and_answers() {
        let history = history_from_messages(&[], "", Path::new("workspace"));
        let system = &history[0].content;

        assert!(system.contains("Always use Simplified Chinese"));
        assert!(system.contains("reasoning text emitted before each tool call"));
        assert!(system.contains("final answer"));
    }

    #[test]
    fn system_prompt_appends_skills_after_runtime_context() {
        let history = history_from_messages(&[], "AVAILABLE SKILLS", Path::new("workspace"));
        let system = &history[0].content;

        let runtime_index = system.find("Runtime environment:").unwrap();
        let host_context_index = system.find("Host app file references:").unwrap();
        let skills_index = system.find("AVAILABLE SKILLS").unwrap();
        assert!(runtime_index < skills_index);
        assert!(runtime_index < host_context_index);
        assert!(host_context_index < skills_index);
    }
}
