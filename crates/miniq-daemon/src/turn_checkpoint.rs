use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use miniq_agent::{AgentError, CheckpointStore, TurnCheckpoint};
use miniq_models::ChatMessage;
use miniq_protocol::{Message, Role};

use crate::agent_task_manager::{AgentRecord, AgentTaskManager};

pub(crate) const UNFINISHED_TURN: &str = "The preceding turn did not finish. Its recorded tool results are retained. Follow the latest user request, not an automatic replay of the interrupted task. Reuse confirmed results. For calls with unknown execution status, inspect actual state before retrying any side effect.";

pub(crate) struct SessionCheckpoint {
    pub store: Arc<miniq_memory::Store>,
    pub session_id: String,
    pub anchor_id: String,
    pub message_id: String,
    pub model_identity: Option<String>,
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
    async fn save(&self, checkpoint: TurnCheckpoint) -> Result<(), AgentError> {
        let mut history = checkpoint.history.into_iter().skip(1).collect::<Vec<_>>();
        history.push(ChatMessage::system(UNFINISHED_TURN));
        crate::security::redact_provider_history(&mut history);
        let message =
            (checkpoint.stopped && !checkpoint.display_text.trim().is_empty()).then(|| Message {
                id: self.message_id.clone(),
                session_id: self.session_id.clone(),
                role: Role::Assistant,
                content: format!("{}\n\n[本轮未完成]", checkpoint.display_text),
                attachments: Vec::new(),
                created_at: miniq_memory::now_iso(),
            });
        let anchor = message
            .as_ref()
            .map_or(self.anchor_id.as_str(), |message| &message.id);
        let history = serde_json::to_value(history)
            .map_err(|error| AgentError::Checkpoint(error.to_string()))?;
        self.store
            .save_context_with_message(
                &self.session_id,
                anchor,
                &history,
                self.model_identity.as_deref(),
                message.as_ref(),
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
