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

    /// Persist a completed commentary segment before subsequent tools can run.
    /// Hosts with no separate visible transcript retain it in provider history.
    async fn commit_interim(&self, _checkpoint: TurnCheckpoint) -> Result<(), AgentError> {
        Ok(())
    }
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

    pub async fn commit_interim(
        &mut self,
        limits: &RunLimits,
        events: &tokio::sync::mpsc::Sender<crate::AgentEvent>,
    ) -> Result<(), AgentError> {
        if let Some(store) = &limits.checkpoint {
            store
                .commit_interim(TurnCheckpoint {
                    history: self.history.clone(),
                    display_text: self.streamed_text.clone(),
                    stopped: false,
                })
                .await?;
        }
        let has_text = !self.streamed_text.is_empty();
        self.partial_text.clear();
        self.streamed_text.clear();
        if has_text {
            let _ = events.send(crate::AgentEvent::TextCommitted).await;
        }
        Ok(())
    }

    pub async fn save(&self, limits: &RunLimits, stopped: bool) -> Result<(), AgentError> {
        let Some(store) = &limits.checkpoint else {
            return Ok(());
        };
        let started = std::time::Instant::now();
        let mut history = self.history.clone();
        if stopped && !self.partial_text.is_empty() {
            // Incomplete provider-native blocks are not valid replay inputs.
            history.push(ChatMessage::assistant(self.partial_text.clone()));
        }
        let result = store
            .save(TurnCheckpoint {
                history,
                display_text: self.streamed_text.clone(),
                stopped,
            })
            .await;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            history_messages = self.history.len(),
            stopped,
            success = result.is_ok(),
            "agent checkpoint finished"
        );
        result
    }
}
