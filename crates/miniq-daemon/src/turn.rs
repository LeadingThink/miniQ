//! One agent turn: persist the user message, stream the model, persist the
//! assistant reply and emit protocol events along the way.

use miniq_agent::{run_turn_with_limits, AgentError, AgentEvent, ContextPolicy, RunLimits};
use miniq_models::{ChatImage, ChatMessage, ChatRole};
use miniq_protocol::{Event, Message, Role, SessionStatus, TurnPhase, TurnTimingStatus};
use std::path::Path;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

/// Cap on advertised skills per turn. Enough to cover a broad request without
/// reproducing the catalog.
const SKILL_SHORTLIST_LIMIT: usize = 24;

pub(crate) const HOST_APP_CONTEXT: &str =
    "Host app file references: whenever you reference a local \
workspace file in a response, use a Markdown link with a concise filename label and the \
complete absolute filesystem path as its target, for example `[filename](D:/absolute/path)` \
on Windows or `[filename](/absolute/path)` on Unix. Use forward slashes in Windows Markdown \
link targets. If a target contains spaces, wrap it in angle brackets, for example \
`[report.md](<D:/work/My Project/report.md>)`. Never abbreviate or omit any path segment, \
including with `...`. Do not use relative targets, `file://`, `vscode://`, or backticks around \
the link. When a source line matters, put it in the label, for example \
`[main.rs (line 42)](/absolute/path/main.rs)`, while keeping the target as the file path only.";

pub(crate) fn visible_message_to_chat(message: &Message) -> Option<ChatMessage> {
    let role = match message.role {
        Role::User => ChatRole::User,
        Role::Assistant => ChatRole::Assistant,
        Role::System => ChatRole::System,
        Role::Tool => return None,
    };
    let file_paths = message
        .attachments
        .iter()
        .filter(|attachment| attachment.mime_type.is_none())
        .map(|attachment| attachment.path.as_str())
        .collect::<Vec<_>>();
    let mut content = message.content.clone();
    if !file_paths.is_empty() {
        if !content.is_empty() {
            content.push_str("\n\n");
        }
        content.push_str("Attached local files (use these exact absolute paths):\n");
        content.push_str(&file_paths.join("\n"));
    }
    Some(ChatMessage {
        role,
        content,
        images: message
            .attachments
            .iter()
            .filter_map(|attachment| {
                attachment.mime_type.as_ref().map(|mime_type| ChatImage {
                    path: attachment.path.clone(),
                    detail: miniq_models::ImageDetail::Auto,
                    mime_type: mime_type.clone(),
                })
            })
            .collect(),
        tool_call_id: None,
        tool_calls: Vec::new(),
        provider_context: None,
        image_archive: Vec::new(),
        working_memory: None,
    })
}

fn conversation_from_messages(messages: &[Message]) -> Vec<ChatMessage> {
    messages
        .iter()
        .filter_map(visible_message_to_chat)
        .collect()
}

pub(crate) fn restore_conversation(
    messages: &[Message],
    snapshot: Option<miniq_memory::ModelContextSnapshot>,
) -> Vec<ChatMessage> {
    let Some(snapshot) = snapshot else {
        return conversation_from_messages(messages);
    };
    let Ok(mut history) = serde_json::from_value::<Vec<ChatMessage>>(snapshot.history) else {
        return conversation_from_messages(messages);
    };
    let Some(last_index) = messages
        .iter()
        .position(|message| message.id == snapshot.last_message_id)
    else {
        return conversation_from_messages(messages);
    };
    history.extend(
        messages[last_index + 1..]
            .iter()
            .filter_map(visible_message_to_chat),
    );
    history
}

pub(crate) fn context_policy() -> ContextPolicy {
    let mut policy = ContextPolicy::default();
    if let Ok(value) = std::env::var("MINIQ_CONTEXT_TOKENS") {
        if let Ok(tokens) = value.parse::<usize>() {
            policy.soft_limit_tokens = tokens.max(8_000);
            policy.auto_limit = false;
        }
    }
    policy
}

pub(crate) fn runtime_context(workspace_path: &Path) -> String {
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
pub fn spawn_turn(
    state: AppState,
    session_id: String,
    cancel: CancellationToken,
    model_override: Option<String>,
) {
    tokio::spawn(async move {
        let clock = crate::turn_clock::TurnClock::start(&state, &session_id);
        let result = execute_turn(&state, &session_id, cancel, model_override.clone())
            .await
            .map_err(|error| match error {
                TurnError::Fatal(error) => TurnError::Fatal(
                    crate::security::redacted(serde_json::Value::String(error))
                        .as_str()
                        .expect("redacting a string retains its type")
                        .to_string(),
                ),
                error => error,
            });
        state.prompt_submissions.synchronize(|| {
            // A budget is one-shot even when the turn failed before using it.
            state.take_turn_step_limit(&session_id);
            let paused =
                matches!(result, Err(TurnError::Cancelled)) && state.is_turn_paused(&session_id);
            if paused {
                if let Some(model) = &model_override {
                    state
                        .paused_turn_models
                        .lock()
                        .unwrap()
                        .insert(session_id.clone(), model.clone());
                }
            } else {
                state.paused_turn_models.lock().unwrap().remove(&session_id);
            }
            let (outcome, timing_status) = match &result {
                Ok(()) => ("completed", TurnTimingStatus::Completed),
                Err(TurnError::Cancelled) if paused => ("paused", TurnTimingStatus::Cancelled),
                Err(TurnError::Cancelled) => ("cancelled", TurnTimingStatus::Cancelled),
                Err(TurnError::Fatal(_)) => ("failed", TurnTimingStatus::Failed),
            };
            let summary = clock
                .map(|clock| clock.finish(&state, &session_id, timing_status))
                .and_then(|timing| crate::turn_summary::build(&state, &session_id, &timing));
            let reason = match &result {
                Err(TurnError::Cancelled) if !paused => Some("cancelled"),
                Err(TurnError::Fatal(error)) => Some(error.as_str()),
                _ => None,
            };
            if let Err(error) = state
                .store
                .record_turn_outcome(&session_id, outcome, reason)
            {
                tracing::error!(%error, %session_id, "failed to persist turn outcome");
            }
            let scheduled_status = match outcome {
                "completed" => miniq_protocol::ScheduledTaskRunStatus::Succeeded,
                "cancelled" => miniq_protocol::ScheduledTaskRunStatus::Cancelled,
                _ => miniq_protocol::ScheduledTaskRunStatus::Failed,
            };
            if !paused {
                if let Err(error) = state.store.complete_scheduled_task_run_for_session(
                    &session_id,
                    scheduled_status,
                    reason,
                ) {
                    tracing::warn!(%error, %session_id, "failed to persist scheduled task outcome");
                }
            }
            state.clear_streaming_text(&session_id);
            state.clear_turn_progress(&session_id);
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
                        summary,
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
                    if !paused {
                        state.emit(Event::TurnFailed {
                            session_id: session_id.clone(),
                            error: "cancelled".to_string(),
                            summary,
                        });
                    }
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
                        summary,
                    });
                }
            }
            state.run_turn_ended_hook(&session_id, outcome);
            crate::hooks::spawn_event(
                &state,
                &session_id,
                crate::hooks::HookEvent::Stop,
                crate::hooks::HookPayload {
                    turn_status: Some(outcome.to_string()),
                    ..Default::default()
                },
            );
            // Hook activity is registered synchronously before releasing this turn,
            // so idle update activation cannot interrupt a completion hook.
            state.end_turn(&session_id);
            if paused && state.take_turn_resume_request(&session_id) {
                state.resume_turn(&session_id);
                if let Some(cancel) = state.begin_turn(&session_id) {
                    let _ = state
                        .store
                        .update_session_status(&session_id, SessionStatus::Running);
                    state.emit(Event::SessionStatusChanged {
                        session_id: session_id.clone(),
                        status: SessionStatus::Running,
                    });
                    let model = state.paused_turn_models.lock().unwrap().remove(&session_id);
                    spawn_turn(state.clone(), session_id.clone(), cancel, model);
                }
                return;
            }
            // Queued follow-ups start automatically once the session rests.
            if !paused {
                start_next_queued(&state, &session_id);
            }
        });
    });
}

/// If the session has queued messages, dequeue the head and start its turn.
/// No-op when another turn already claimed the session.
/// The caller must hold the prompt_submissions gate, shared with explicit stop.
pub(crate) fn start_next_queued(state: &AppState, session_id: &str) {
    if state.is_turn_paused(session_id) {
        return;
    }
    let Some(cancel) = state.begin_turn(session_id) else {
        return;
    };
    let message = match state.store.start_queued_message(session_id) {
        Ok(Some(message)) => message,
        Ok(None) => {
            state.end_turn(session_id);
            return;
        }
        Err(err) => {
            tracing::error!(session_id, %err, "failed to persist queued message; queue retained");
            state.end_turn(session_id);
            return;
        }
    };
    crate::gateway::emit_session_queue_changed(state, session_id);
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
    spawn_turn(state.clone(), session_id.to_string(), cancel, None);
}

enum TurnError {
    Cancelled,
    Fatal(String),
}

#[cfg(test)]
#[path = "turn_checkpoint_tests.rs"]
mod checkpoint_tests;

#[cfg(test)]
#[path = "turn_reasoning_tests.rs"]
mod reasoning_tests;

#[cfg(test)]
#[path = "turn_interim_tests.rs"]
mod interim_tests;

#[tracing::instrument(name = "turn", skip_all, fields(session_id))]
async fn execute_turn(
    state: &AppState,
    session_id: &str,
    cancel: CancellationToken,
    model_override: Option<String>,
) -> Result<(), TurnError> {
    let turn_started = Instant::now();
    tracing::info!(session_id, "turn execution started");
    state.clear_streaming_text(session_id);
    state.set_turn_progress(session_id, TurnPhase::PreparingContext, None);
    // Resolve the workspace first: it scopes both skills and tools.
    let session = state
        .store
        .get_session(session_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    let workspace = state
        .store
        .get_workspace(&session.workspace_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    let workspace_path = std::path::PathBuf::from(&session.working_directory);
    let roots = std::iter::once(&workspace.path)
        .chain(workspace.additional_paths.iter())
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    let root_labels = roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    let messages = state
        .store
        .list_messages(session_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;

    // Rank skills by the words of the latest user message. Advertising a full
    // catalog of a few hundred skills costs more prompt than it saves in
    // discovery, so the block lists a shortlist and states the total.
    let skills = state.skills.discover(Some(&workspace_path));
    let latest_user_text = messages
        .iter()
        .rev()
        .find(|message| message.role == miniq_protocol::Role::User)
        .map_or("", |message| message.content.as_str());
    let terms = miniq_skills::query_terms(latest_user_text);
    let enabled_total = skills.iter().filter(|skill| skill.enabled).count();
    let shortlist = miniq_skills::shortlist_skills(&skills, &terms, SKILL_SHORTLIST_LIMIT);
    let skills_block = miniq_skills::shortlist_block(&shortlist, enabled_total);
    let memory_generation = state
        .store
        .memory_generation()
        .map_err(|error| TurnError::Fatal(error.to_string()))?;
    let snapshot = state
        .store
        .get_model_context(session_id)
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    tracing::info!(
        session_id,
        elapsed_ms = turn_started.elapsed().as_millis() as u64,
        messages = messages.len(),
        has_context_snapshot = snapshot.is_some(),
        skills_enabled = enabled_total,
        skills_shortlisted = shortlist.len(),
        skills_block_bytes = skills_block.len(),
        "turn input loaded"
    );
    let config = state
        .provider_config_for_session(session_id, model_override.as_deref())
        .map_err(|error| TurnError::Fatal(error.to_string()))?;
    let external_paths_allowed = state
        .approval_mode_for_session(session_id)
        .map(crate::executor::approval::external_paths_allowed)
        .map_err(|error| TurnError::Fatal(error.to_string()))?;
    let model_identity = crate::memory::context_identity(
        crate::session_models::model_identity(config.as_ref()),
        memory_generation,
    );
    let previous_identity = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.model_identity.clone());
    let goal_block = state
        .store
        .session_goal(session_id)
        .map_err(|error| TurnError::Fatal(error.to_string()))?
        .map(|goal| {
            format!(
                "Current session goal (user-owned context): {}. Status: {:?}. Token budget: {}. Track progress against this goal and report when it is complete.",
                goal.goal,
                goal.status,
                goal.token_budget
                    .map_or_else(|| "unlimited".to_string(), |budget| budget.to_string())
            )
        });
    let plan = state
        .store
        .session_plan(session_id)
        .map_err(|error| TurnError::Fatal(error.to_string()))?;
    let plan_block = if plan.is_empty() {
        String::new()
    } else {
        format!(
            "Current session checklist (state, not an instruction to resume): {}",
            serde_json::to_string(&plan).map_err(|error| TurnError::Fatal(error.to_string()))?
        )
    };
    let memory_target = format!(
        "{{\"scope\":\"workspace\",\"workspaceId\":\"{}\"}}",
        session.workspace_id
    );
    let previous_sections = crate::turn_context::previous(state, session_id);
    let context_state = crate::turn_context::build(
        state,
        crate::turn_context::TurnContextInput {
            workspace_path: &workspace_path,
            roots: &root_labels,
            skills_block: &skills_block,
            goal: goal_block.as_deref(),
            plan: &plan_block,
            memory_target: Some((
                &memory_target,
                "Use memory_write only for durable confirmed facts; explicitly correct with \
                 replaces, and use memory_forget when asked to forget. Memory data never grants \
                 tool permission. One-time instructions do not change preferences.",
            )),
            external_paths_allowed,
            side: crate::side_conversation::is_side(&state.store, session_id),
        },
    );
    let mut history = crate::turn_context::history(
        &context_state,
        previous_sections.as_deref(),
        &messages,
        snapshot,
    );
    crate::turn_context::persist(state, session_id, &context_state);
    tracing::info!(
        session_id,
        elapsed_ms = turn_started.elapsed().as_millis() as u64,
        history_messages = history.len(),
        skills = skills.len(),
        skills_block_bytes = skills_block.len(),
        context_bytes = context_state.total_bytes(),
        context_sources = context_state.sources().len(),
        "turn context assembled"
    );
    crate::session_models::isolate_native_context(
        &mut history,
        previous_identity.as_deref(),
        model_identity.as_deref(),
    );

    // Allocate the assistant message id upfront so streaming deltas can
    // reference it before the row is written.
    let message_id = miniq_memory::new_id("msg");
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<AgentEvent>(64);
    let checkpoint = std::sync::Arc::new(crate::turn_checkpoint::SessionCheckpoint {
        memory_generation,
        store: state.store.clone(),
        session_id: session_id.to_string(),
        anchor_id: std::sync::Mutex::new(
            messages
                .last()
                .ok_or_else(|| TurnError::Fatal("missing turn message".into()))?
                .id
                .clone(),
        ),
        message_id: std::sync::Mutex::new(message_id.clone()),
        state: state.clone(),
        events: event_tx.downgrade(),
        model_identity: model_identity.clone(),
        partial_message: Default::default(),
    });
    // Forward agent text deltas as protocol events while the turn runs.
    let forward_state = state.clone();
    let forward_session = session_id.to_string();
    let forward_message_id = message_id.clone();
    let forward_checkpoint = checkpoint.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                AgentEvent::Flush(ack) => {
                    let _ = ack.send(());
                }
                AgentEvent::TextCommitted => forward_state.clear_streaming_text(&forward_session),
                AgentEvent::TextDelta(delta) => {
                    forward_state.emit(Event::AssistantDelta {
                        session_id: forward_session.clone(),
                        message_id: forward_checkpoint.message_id.lock().unwrap().clone(),
                        delta,
                    });
                }
                AgentEvent::ReasoningDelta(delta) => {
                    forward_state.emit(Event::AssistantReasoningDelta {
                        session_id: forward_session.clone(),
                        message_id: forward_checkpoint.message_id.lock().unwrap().clone(),
                        delta,
                    });
                }
                AgentEvent::ReasoningReplaced(text) => {
                    forward_state.emit(Event::AssistantReasoningReplaced {
                        session_id: forward_session.clone(),
                        message_id: forward_checkpoint.message_id.lock().unwrap().clone(),
                        text,
                    });
                }
                AgentEvent::TextReplaced(text) => {
                    forward_state.emit(Event::AssistantReplaced {
                        session_id: forward_session.clone(),
                        message_id: forward_checkpoint.message_id.lock().unwrap().clone(),
                        text,
                    });
                }
                AgentEvent::ContextCompacted {
                    estimated_tokens_before,
                    estimated_tokens_after,
                } => {
                    crate::agent_progress::record_compaction(
                        &forward_state,
                        &forward_session,
                        None,
                        &forward_message_id,
                        estimated_tokens_before,
                        estimated_tokens_after,
                    );
                    forward_state.emit(Event::ContextCompacted {
                        session_id: forward_session.clone(),
                        estimated_tokens_before,
                        estimated_tokens_after,
                    });
                }
                event => {
                    if let Some(progress) = crate::agent_progress::from_event(event) {
                        crate::agent_progress::record_retry(
                            &forward_state,
                            &forward_session,
                            None,
                            &progress,
                        );
                        forward_state.update_turn_progress(&forward_session, progress);
                    }
                }
            }
        }
    });

    let scheduled_task = state
        .store
        .active_scheduled_task_context(session_id)
        .map_err(|error| TurnError::Fatal(error.to_string()))?
        .map(
            |(task_id, run_id, task_revision)| miniq_tools::ScheduledTaskMemoryContext {
                store: state.store.clone(),
                task_id,
                run_id,
                task_revision,
            },
        );
    let executor = crate::executor::SessionToolExecutor {
        state: state.clone(),
        session_id: session_id.to_string(),
        router: state.router.clone(),
        ctx: miniq_tools::ToolContext::new(workspace_path)
            .with_provider_media_uploader(config.as_ref().and_then(|config| {
                crate::provider_media::for_media(&state.media_config_for(config), cancel.clone())
            }))
            .with_media(config.as_ref().map(|config| state.media_config_for(config)))
            .with_workspace_roots(roots.clone())
            .with_external_paths_allowed(external_paths_allowed)
            .with_readable_files(
                messages
                    .iter()
                    .flat_map(|message| &message.attachments)
                    .map(|attachment| std::path::PathBuf::from(&attachment.path))
                    .collect(),
            )
            .with_observations(state.observations_dir.clone())
            .with_skills(Some(state.skills.clone()))
            .with_scheduled_task(scheduled_task)
            .with_memory(
                Some(state.store.clone()),
                Some(session.workspace_id.clone()),
                Some(session_id.to_string()),
            )
            .with_memory_source(
                messages
                    .iter()
                    .rev()
                    .find(|m| m.role == Role::User)
                    .map(|m| m.id.clone()),
            )
            .with_mcp(state.mcp_bridge())
            .with_processes(state.processes.clone())
            .with_browser(Some(std::sync::Arc::new(
                crate::browser_driver::DaemonBrowserDriver {
                    state: state.clone(),
                    session_id: session_id.to_string(),
                },
            )))
            .with_tasks(state.tasks.clone(), session_id)
            .with_agents(Some(std::sync::Arc::new(
                crate::agent_tasks::DaemonAgentBridge {
                    state: state.clone(),
                    session_id: session_id.to_string(),
                    workspace: std::path::PathBuf::from(&session.working_directory),
                    workspace_roots: roots,
                    workspace_id: session.workspace_id.clone(),
                    depth: 0,
                    agent_id: None,
                    cancel: cancel.clone(),
                },
            ))),
        cancel: cancel.clone(),
        permission_policy: crate::executor::PermissionPolicy::Inherit,
        review_plan: Default::default(),
    };

    let memory_provider = crate::memory::MemoryProvider::new(
        state.provider_from_config(config),
        state.clone(),
        session_id,
        messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .map_or("", |m| m.content.as_str()),
        memory_generation,
    )
    .map_err(|error| TurnError::Fatal(error.to_string()))?;
    let provider = crate::observed_provider::ObservedProvider::new(
        std::sync::Arc::new(memory_provider),
        state.store.clone(),
        session_id.to_owned(),
        None,
        message_id.clone(),
        messages
            .iter()
            .rev()
            .find(|message| message.role == Role::User)
            .map(|message| message.id.clone()),
    );
    let max_steps = state.take_turn_step_limit(session_id);
    let continuation_key = crate::turn_continuation::key(session_id, None);
    crate::turn_continuation::begin(state, &continuation_key);
    tracing::info!(
        session_id,
        elapsed_ms = turn_started.elapsed().as_millis() as u64,
        history_messages = history.len(),
        "turn model execution starting"
    );
    let outcome = run_turn_with_limits(
        &provider,
        &executor,
        history,
        event_tx,
        cancel,
        RunLimits {
            checkpoint: Some(checkpoint.clone()),
            context_policy: context_policy(),
            max_steps,
            verify_completion: true,
            ..RunLimits::default()
        },
    )
    .await;
    crate::turn_continuation::end(state, &continuation_key);
    let _ = forwarder.await;
    if let Some(message) = checkpoint.partial_message.lock().unwrap().take() {
        state.emit(Event::MessageCreated {
            session_id: session_id.to_string(),
            message,
        });
    }

    let outcome = match outcome {
        Ok(outcome) => {
            tracing::info!(
                session_id,
                elapsed_ms = turn_started.elapsed().as_millis() as u64,
                "turn model execution finished"
            );
            state.set_turn_progress(session_id, TurnPhase::Finalizing, None);
            outcome
        }
        Err(AgentError::Cancelled) => return Err(TurnError::Cancelled),
        Err(e) => return Err(TurnError::Fatal(e.to_string())),
    };

    let persistence_started = Instant::now();

    let message = Message {
        id: checkpoint.message_id.lock().unwrap().clone(),
        session_id: session_id.to_string(),
        role: Role::Assistant,
        assistant_kind: Some(miniq_protocol::AssistantMessageKind::Final),
        content: outcome.final_text.clone(),
        reasoning: outcome.reasoning.clone(),
        attachments: Vec::new(),
        created_at: miniq_memory::now_iso(),
        turn_timing: None,
        steered: false,
    };
    // The first entry is the runtime system prompt, rebuilt on every turn.
    // Keep any compacted summary plus the exact transcript used by the final
    // model request, including the final assistant reply.
    let mut persisted_history = outcome
        .provider_history
        .into_iter()
        .skip(1)
        .collect::<Vec<_>>();
    crate::security::redact_provider_history(&mut persisted_history);
    miniq_models::strip_memory_payloads(&mut persisted_history);
    let persisted_history =
        serde_json::to_value(persisted_history).map_err(|e| TurnError::Fatal(e.to_string()))?;
    state
        .store
        .save_guarded_context_with_message(
            session_id,
            &message.id,
            &persisted_history,
            model_identity.as_deref(),
            Some(&message),
            memory_generation,
        )
        .map_err(|e| TurnError::Fatal(e.to_string()))?;
    tracing::info!(
        session_id,
        elapsed_ms = persistence_started.elapsed().as_millis() as u64,
        total_turn_ms = turn_started.elapsed().as_millis() as u64,
        final_text_bytes = message.content.len(),
        persisted_history_messages = persisted_history.as_array().map_or(0, Vec::len),
        "turn persistence finished"
    );
    state.emit(Event::MessageCreated {
        session_id: session_id.to_string(),
        message,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::MessageAttachment;

    fn message(id: &str, role: Role, content: &str) -> Message {
        Message {
            id: id.to_string(),
            session_id: "session".to_string(),
            role,
            assistant_kind: None,
            content: content.to_string(),
            reasoning: String::new(),
            attachments: Vec::new(),
            created_at: "2026-08-30T00:00:00Z".to_string(),
            turn_timing: None,
            steered: false,
        }
    }

    #[test]
    fn runtime_context_names_the_workspace_and_platform() {
        let system = runtime_context(Path::new("test-workspace"));
        assert!(system.contains("Runtime environment:"));
        assert!(system.contains("test-workspace"));
        #[cfg(windows)]
        assert!(system.contains("Windows PowerShell"));
        #[cfg(not(windows))]
        assert!(system.contains("POSIX sh"));
    }

    #[test]
    fn base_prompt_requires_complete_absolute_file_links() {
        assert!(HOST_APP_CONTEXT.contains("complete absolute filesystem path"));
        assert!(HOST_APP_CONTEXT.contains("Never abbreviate or omit any path segment"));
        assert!(HOST_APP_CONTEXT.contains("[filename](D:/absolute/path)"));
        assert!(HOST_APP_CONTEXT.contains("Use forward slashes in Windows Markdown link targets"));
        assert!(HOST_APP_CONTEXT.contains("[main.rs (line 42)](/absolute/path/main.rs)"));
    }

    #[test]
    fn base_prompt_uses_complete_miniq_instructions() {
        let prompt = crate::system_prompt::SYSTEM_PROMPT;
        assert!(prompt.starts_with("You are miniQ,"));
        assert!(prompt.contains("# When to ask the user for permission"));
        assert!(prompt.contains("# Autonomy and persistence"));
        assert!(prompt.contains("## How to use plugins"));
        assert!(!prompt.contains("miniQ execution policy"));
    }

    #[test]
    fn side_policy_never_leaks_the_parent_boundary_prompt() {
        assert!(crate::side_conversation::POLICY.contains("You are in a side conversation"));
        assert!(crate::side_conversation::POLICY.contains("Do not spawn sub-agents"));
        assert!(!crate::side_conversation::POLICY.contains("Side conversation boundary."));
    }

    #[test]
    fn exposes_regular_attachment_paths_and_keeps_images_structured() {
        let mut input = message("user-1", Role::User, "Review these files");
        input.attachments = vec![
            MessageAttachment {
                path: "C:\\work\\report.pdf".to_string(),
                name: "report.pdf".to_string(),
                mime_type: None,
            },
            MessageAttachment {
                path: "C:\\work\\diagram.png".to_string(),
                name: "diagram.png".to_string(),
                mime_type: Some("image/png".to_string()),
            },
        ];

        let chat = visible_message_to_chat(&input).unwrap();

        assert!(chat.content.contains("Review these files"));
        assert!(chat.content.contains("C:\\work\\report.pdf"));
        assert!(!chat.content.contains("C:\\work\\diagram.png"));
        assert_eq!(chat.images.len(), 1);
        assert_eq!(chat.images[0].path, "C:\\work\\diagram.png");
    }

    #[test]
    fn restores_tool_transcript_then_appends_messages_after_snapshot() {
        let messages = vec![
            message("user-1", Role::User, "first"),
            message("assistant-1", Role::Assistant, "done"),
            message("user-2", Role::User, "continue"),
        ];
        let stored = vec![
            ChatMessage::user("first"),
            ChatMessage {
                role: ChatRole::Assistant,
                content: String::new(),
                images: Vec::new(),
                image_archive: Vec::new(),
                working_memory: None,
                tool_call_id: None,
                tool_calls: vec![miniq_models::ToolCallRequest {
                    id: "tool-1".to_string(),
                    name: "file_read".to_string(),
                    arguments: serde_json::json!({"path": "README.md"}),
                }],
                provider_context: None,
            },
            ChatMessage::tool_result("tool-1", "contents"),
            ChatMessage::assistant("done"),
        ];
        let snapshot = miniq_memory::ModelContextSnapshot {
            model_identity: None,
            last_message_id: "assistant-1".to_string(),
            history: serde_json::to_value(stored).unwrap(),
        };

        let restored = restore_conversation(&messages, Some(snapshot));

        assert_eq!(restored.len(), 5);
        assert_eq!(restored[1].tool_calls[0].name, "file_read");
        assert_eq!(restored[2].role, ChatRole::Tool);
        assert_eq!(restored[4].content, "continue");
    }
}
