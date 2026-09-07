use async_trait::async_trait;
use miniq_models::ChatMessage;

use crate::{AgentError, RunLimits};

#[derive(Clone, Debug)]
pub struct TurnCheckpoint {
    pub history: Vec<ChatMessage>,
    pub display_text: String,
    pub stopped: bool,
}

/// Hosts persist checkpoints before the runner can dispatch another side effect.
#[async_trait]
pub trait CheckpointStore: Send + Sync + std::fmt::Debug {
    async fn save(&self, checkpoint: TurnCheckpoint) -> Result<(), AgentError>;
}

pub(crate) struct RunState {
    pub history: Vec<ChatMessage>,
    pub appended: Vec<ChatMessage>,
    pub streamed_text: String,
    pub partial_text: String,
}

impl RunState {
    pub fn new(history: Vec<ChatMessage>) -> Self {
        Self {
            history,
            appended: Vec::new(),
            streamed_text: String::new(),
            partial_text: String::new(),
        }
    }

    pub async fn save(&self, limits: &RunLimits, stopped: bool) -> Result<(), AgentError> {
        let Some(store) = &limits.checkpoint else {
            return Ok(());
        };
        let mut history = self.history.clone();
        if stopped && !self.partial_text.is_empty() {
            // Incomplete provider-native blocks are not valid replay inputs.
            history.push(ChatMessage::assistant(self.partial_text.clone()));
        }
        store
            .save(TurnCheckpoint {
                history,
                display_text: self.streamed_text.clone(),
                stopped,
            })
            .await
    }
}
