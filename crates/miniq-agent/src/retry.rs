use std::time::Duration;

use miniq_models::ProviderError;
use tokio_util::sync::CancellationToken;

use crate::{AgentError, AgentEvent, RetryAttempt};

const MAX_RETRY_DELAY: Duration = Duration::from_secs(120);

pub(super) struct ModelRetries {
    pub attempts: usize,
    max_attempts: usize,
}

impl ModelRetries {
    pub fn new(max_attempts: usize) -> Self {
        Self {
            attempts: 0,
            max_attempts,
        }
    }

    pub fn available(&self) -> bool {
        self.attempts < self.max_attempts
    }

    pub fn progress(&self) -> Option<RetryAttempt> {
        (self.attempts > 0).then_some(RetryAttempt {
            attempt: self.attempts,
            max_attempts: self.max_attempts,
        })
    }

    fn stopped(&self, error: &ProviderError, reason: String) -> AgentError {
        AgentError::ModelRetryStopped {
            attempts: self.attempts,
            max_attempts: self.max_attempts,
            reason,
            last_error: error.to_string(),
        }
    }

    pub async fn wait(
        &mut self,
        error: &ProviderError,
        step: usize,
        events: &tokio::sync::mpsc::Sender<AgentEvent>,
        cancel: &CancellationToken,
    ) -> Result<bool, AgentError> {
        if cancel.is_cancelled() {
            return Err(AgentError::Cancelled);
        }
        if !error.is_retryable() {
            return Ok(false);
        }
        if !self.available() {
            return Err(self.stopped(error, "已达到重试次数上限".into()));
        }
        let delay = Duration::from_secs(1 << self.attempts.min(5))
            .max(error.retry_after().unwrap_or_default())
            .saturating_add(Duration::from_millis(rand::random_range(0..250)));
        // Slow provider calls do not consume a separate wall-clock retry budget.
        // Do not retry earlier than a server hint that exceeds the automatic wait limit.
        if let Some(hint) = error.retry_after().filter(|hint| *hint > MAX_RETRY_DELAY) {
            return Err(self.stopped(
                error,
                format!(
                    "服务端要求等待 {} 秒，超过自动等待上限 {} 秒，请稍后继续",
                    hint.as_secs(),
                    MAX_RETRY_DELAY.as_secs()
                ),
            ));
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
