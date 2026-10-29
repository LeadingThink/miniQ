use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use miniq_agent::{AgentError, CheckpointStore, TurnCheckpoint};
use miniq_models::ChatMessage;
use miniq_protocol::{Message, Role};

use crate::agent_task_manager::{AgentRecord, AgentTaskManager};
use crate::state::AppState;

pub(crate) const UNFINISHED_TURN: &str = "The preceding turn did not finish. Its recorded tool results are retained. Follow the latest user request, not an automatic replay of the interrupted task. Reuse confirmed results. For calls with unknown execution status, inspect actual state before retrying any side effect.";

pub(crate) struct SessionCheckpoint {
    pub store: Arc<miniq_memory::Store>,
    pub session_id: String,
    pub message_id: Mutex<String>,
    pub state: AppState,
    pub events: tokio::sync::mpsc::WeakSender<miniq_agent::AgentEvent>,
    pub anchor_id: Mutex<String>,
    pub model_identity: Option<String>,
    pub memory_generation: i64,
    pub partial_message: Mutex<Option<Message>>,
}

impl std::fmt::Debug for SessionCheckpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionCheckpoint")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl CheckpointStore for SessionCheckpoint {
    async fn commit_interim(&self, checkpoint: TurnCheckpoint) -> Result<(), AgentError> {
        let (ack, drained) = tokio::sync::oneshot::channel();
        self.events
            .upgrade()
            .ok_or_else(|| AgentError::Checkpoint("event forwarder closed".into()))?
            .send(miniq_agent::AgentEvent::Flush(ack))
            .await
            .map_err(|_| AgentError::Checkpoint("event forwarder closed".into()))?;
        drained
            .await
            .map_err(|_| AgentError::Checkpoint("event forwarder closed".into()))?;
        let mut history = checkpoint.history.into_iter().skip(1).collect::<Vec<_>>();
        history.push(ChatMessage::system(UNFINISHED_TURN));
        crate::security::redact_provider_history(&mut history);
        miniq_models::strip_memory_payloads(&mut history);
        let history =
            serde_json::to_value(history).map_err(|e| AgentError::Checkpoint(e.to_string()))?;
        let message = (!checkpoint.display_text.trim().is_empty()).then(|| Message {
            id: self.message_id.lock().unwrap().clone(),
            session_id: self.session_id.clone(),
            role: Role::Assistant,
            assistant_kind: Some(miniq_protocol::AssistantMessageKind::Commentary),
            content: checkpoint.display_text,
            attachments: Vec::new(),
            created_at: miniq_memory::now_iso(),
            turn_timing: None,
            steered: false,
        });
        let anchor = message
            .as_ref()
            .map(|m| m.id.clone())
            .unwrap_or_else(|| self.anchor_id.lock().unwrap().clone());
        self.store
            .save_guarded_context_with_message(
                &self.session_id,
                &anchor,
                &history,
                self.model_identity.as_deref(),
                message.as_ref(),
                self.memory_generation,
            )
            .map_err(|e| AgentError::Checkpoint(e.to_string()))?;
        *self.anchor_id.lock().unwrap() = anchor;
        if let Some(message) = message {
            self.state.emit(miniq_protocol::Event::MessageCreated {
                session_id: self.session_id.clone(),
                message,
            });
        } else {
            self.state.clear_streaming_text(&self.session_id);
        }
        *self.message_id.lock().unwrap() = miniq_memory::new_id("msg");
        Ok(())
    }

    async fn save(&self, checkpoint: TurnCheckpoint) -> Result<(), AgentError> {
        let mut history = checkpoint.history.into_iter().skip(1).collect::<Vec<_>>();
        history.push(ChatMessage::system(UNFINISHED_TURN));
        crate::security::redact_provider_history(&mut history);
        miniq_models::strip_memory_payloads(&mut history);
        let message =
            (checkpoint.stopped && !checkpoint.display_text.trim().is_empty()).then(|| Message {
                id: self.message_id.lock().unwrap().clone(),
                session_id: self.session_id.clone(),
                role: Role::Assistant,
                assistant_kind: Some(miniq_protocol::AssistantMessageKind::Interrupted),
                content: format!("{}\n\n[本轮未完成]", checkpoint.display_text),
                attachments: Vec::new(),
                created_at: miniq_memory::now_iso(),
                turn_timing: None,
                steered: false,
            });
        let anchor = message
            .as_ref()
            .map(|message| message.id.clone())
            .unwrap_or_else(|| self.anchor_id.lock().unwrap().clone());
        let history = serde_json::to_value(history)
            .map_err(|error| AgentError::Checkpoint(error.to_string()))?;
        self.store
            .save_guarded_context_with_message(
                &self.session_id,
                &anchor,
                &history,
                self.model_identity.as_deref(),
                message.as_ref(),
                self.memory_generation,
            )
            .map_err(|error| AgentError::Checkpoint(error.to_string()))?;
        if message.is_some() {
            *self.partial_message.lock().unwrap() = message;
        }
        Ok(())
    }
}

pub(crate) struct AgentCheckpoint {
    pub manager: Arc<AgentTaskManager>,
    pub record: Arc<AgentRecord>,
}

impl std::fmt::Debug for AgentCheckpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentCheckpoint")
            .field("agent_id", &self.record.id)
            .finish()
    }
}

#[async_trait]
impl CheckpointStore for AgentCheckpoint {
    async fn save(&self, mut checkpoint: TurnCheckpoint) -> Result<(), AgentError> {
        checkpoint
            .history
            .push(ChatMessage::system(UNFINISHED_TURN));
        self.manager
            .save_history(&self.record, &checkpoint.history)
            .await
            .map_err(|error| AgentError::Checkpoint(error.to_string()))
    }
}
