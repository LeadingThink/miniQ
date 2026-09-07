use std::time::Duration;

use miniq_models::ProviderError;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{AgentError, AgentEvent};

const MAX_RETRY_DELAY: Duration = Duration::from_secs(120);
const MAX_RETRY_WINDOW: Duration = Duration::from_secs(300);

pub(super) struct ModelRetries {
    pub attempts: usize,
    max_attempts: usize,
    started: Option<Instant>,
}

impl ModelRetries {
    pub fn new(max_attempts: usize) -> Self {
        Self {
            attempts: 0,
            max_attempts,
            started: None,
        }
    }

    pub fn available(&self) -> bool {
        self.attempts < self.max_attempts
    }

    pub async fn wait(
        &mut self,
        error: &ProviderError,
        step: usize,
        events: &tokio::sync::mpsc::Sender<AgentEvent>,
        cancel: &CancellationToken,
    ) -> Result<bool, AgentError> {
        if !self.available() || !error.is_retryable() {
            return Ok(false);
        }
        let started = self.started.get_or_insert_with(Instant::now);
        let delay = Duration::from_secs(1 << self.attempts.min(5))
            .max(error.retry_after().unwrap_or_default())
            .saturating_add(Duration::from_millis(rand::random_range(0..250)));
        // Never shorten a server's Retry-After hint to fit the local budget.
        if delay > MAX_RETRY_DELAY || started.elapsed().saturating_add(delay) > MAX_RETRY_WINDOW {
            return Ok(false);
        }
        self.attempts += 1;
        tokio::select! {
            _ = cancel.cancelled() => return Err(AgentError::Cancelled),
            _ = events.send(AgentEvent::ModelRetryScheduled {
                step, attempt: self.attempts, max_attempts: self.max_attempts, delay_ms: delay.as_millis() as u64,
            }) => {},
        }
        tokio::select! {
            _ = cancel.cancelled() => Err(AgentError::Cancelled),
            _ = tokio::time::sleep(delay) => Ok(true),
        }
    }
}

#[cfg(test)]
mod tests;
