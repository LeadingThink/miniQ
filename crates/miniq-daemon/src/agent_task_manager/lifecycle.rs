use miniq_agent::AgentError;

use super::*;

impl AgentTaskManager {
    pub(crate) async fn finish_turn(
        &self,
        record: &AgentRecord,
        result: String,
        mut history: Vec<ChatMessage>,
    ) -> Result<Option<Vec<ChatMessage>>, ToolError> {
        let mut guard = record.state.lock().await;
        let mut state = guard.clone();
        state.progress = None;
        state.has_history = true;
        let next = if state.cancel.is_cancelled() {
            state.inbox.clear();
            false
        } else if let Some(message) = state.inbox.pop_front() {
            // Dequeue and checkpoint the next prompt together, without a crash gap.
            history.push(ChatMessage::user(message));
            true
        } else {
            false
        };
        if !next {
            state.status = AgentStatus::Finalizing;
        }
        self.persist(record, &state, Some(&history), Some(Some(&result)))?;
        *guard = state;
        Ok(next.then_some(history))
    }

    pub(crate) async fn complete(&self, record: &AgentRecord) -> Result<(), ToolError> {
        let mut state = record.state.lock().await;
        state.progress = None;
        if matches!(
            state.status,
            AgentStatus::Finalizing | AgentStatus::Stopping
        ) {
            state.status = if state.cancel.is_cancelled() {
                AgentStatus::Cancelled
            } else {
                AgentStatus::Completed
            };
        }
        state.finish_timing();
        let saved = self.persist(record, &state, None, None);
        drop(state);
        record.changed.notify_waiters();
        saved
    }

    pub(crate) async fn finish_error(
        &self,
        record: &AgentRecord,
        error: &AgentError,
    ) -> Result<(), ToolError> {
        let mut state = record.state.lock().await;
        state.progress = None;
        let caller_stopped = state.status == AgentStatus::Stopping;
        state.status = if state.cancel.is_cancelled() || matches!(error, AgentError::Cancelled) {
            state.inbox.clear();
            AgentStatus::Cancelled
        } else {
            AgentStatus::Failed
        };
        if !caller_stopped {
            state.error = Some(error.to_string());
        }
        state.finish_timing();
        let saved = self.persist(record, &state, None, None);
        drop(state);
        record.changed.notify_waiters();
        saved
    }

    /// Terminal storage failures must still stop live execution and wake waiters.
    pub(crate) async fn fail_start(&self, record: &AgentRecord, error: &ToolError) {
        let mut state = record.state.lock().await;
        state.progress = None;
        state.status = AgentStatus::Failed;
        state.error = Some(error.to_string());
        state.finish_timing();
        if let Err(error) = self.persist(record, &state, None, None) {
            tracing::error!(agent_id = record.id, %error, "cannot persist terminal agent state");
        }
        drop(state);
        record.changed.notify_waiters();
    }
}
