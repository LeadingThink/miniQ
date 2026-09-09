//! Credential-free, durable request diagnostics, including dropped futures.

use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Instant,
};

use async_trait::async_trait;
use futures_util::Stream;
use miniq_memory::{new_id, now_iso, Store};
use miniq_models::{
    ChatDelta, CompletionRequest, DeltaStream, ModelCapabilities, ModelProvider, ProviderError,
};
use miniq_protocol::{ModelCallRecord, ModelCallStatus, ModelExecutionInfo};

pub(crate) struct ObservedProvider {
    inner: Arc<dyn ModelProvider>,
    store: Arc<Store>,
    session_id: String,
    agent_id: Option<String>,
    turn_id: String,
    source_message_id: Option<String>,
}

impl ObservedProvider {
    pub(crate) fn new(
        inner: Arc<dyn ModelProvider>,
        store: Arc<Store>,
        session_id: String,
        agent_id: Option<String>,
        turn_id: String,
        source_message_id: Option<String>,
    ) -> Self {
        Self {
            inner,
            store,
            session_id,
            agent_id,
            turn_id,
            source_message_id,
        }
    }
}

struct CallGuard {
    store: Arc<Store>,
    record: ModelCallRecord,
    started: Instant,
}

impl CallGuard {
    fn save(&self) {
        if let Err(error) = self.store.save_model_call(&self.record) {
            tracing::warn!(call_id = %self.record.id, %error, "could not persist model diagnostics");
        }
    }

    fn finish(&mut self, status: ModelCallStatus, error: Option<&ProviderError>) {
        if self.record.status != ModelCallStatus::Running {
            return;
        }
        self.record.status = status;
        self.record.completed_at = Some(now_iso());
        self.record.elapsed_ms = Some(
            self.started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        );
        self.record.error = error.map(|error| {
            let detail = match error {
                // reqwest embeds URLs, potentially containing credentials.
                ProviderError::Http(error) => format!(
                    "http error: {}",
                    if error.is_decode() {
                        "response decoding failed"
                    } else if error.is_timeout() {
                        "timeout"
                    } else if error.is_connect() {
                        "connection failed"
                    } else {
                        "transport failed"
                    }
                ),
                ProviderError::Api { status, body, .. } => format!(
                    "provider returned {status}: {}",
                    crate::security::redacted(
                        serde_json::from_str(body).unwrap_or_else(|_| body.clone().into())
                    )
                ),
                _ => error.to_string(),
            };
            crate::security::redacted(detail.into())
                .as_str()
                .unwrap()
                .to_owned()
        });
        self.save();
    }
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        self.finish(ModelCallStatus::Interrupted, None);
    }
}

struct ObservedStream {
    inner: DeltaStream,
    guard: CallGuard,
}

impl Stream for ObservedStream {
    type Item = Result<ChatDelta, ProviderError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let next = this.inner.as_mut().poll_next(cx);
        match &next {
            Poll::Ready(Some(Ok(ChatDelta::ResponseInfo(info)))) => {
                let sanitized = serde_json::from_value(crate::security::redacted(
                    serde_json::to_value(info).expect("serializable response metadata"),
                ))
                .expect("redaction preserves metadata structure");
                if this.guard.record.response.merge(sanitized) {
                    this.guard.save();
                }
            }
            Poll::Ready(Some(Ok(ChatDelta::Finished))) => {
                this.guard.finish(ModelCallStatus::Completed, None)
            }
            Poll::Ready(Some(Err(error))) => {
                this.guard.finish(ModelCallStatus::Failed, Some(error))
            }
            Poll::Ready(None) => this.guard.finish(
                ModelCallStatus::Failed,
                Some(&ProviderError::IncompleteStream),
            ),
            _ => {}
        }
        next
    }
}

#[async_trait]
impl ModelProvider for ObservedProvider {
    async fn execution_info(
        &self,
        max_output_tokens: Option<u32>,
    ) -> Result<Option<ModelExecutionInfo>, ProviderError> {
        self.inner.execution_info(max_output_tokens).await
    }

    async fn capabilities(&self) -> ModelCapabilities {
        self.inner.capabilities().await
    }

    fn describe(&self) -> String {
        self.inner.describe()
    }

    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        let mut guard = CallGuard {
            store: self.store.clone(),
            started: Instant::now(),
            record: ModelCallRecord {
                id: new_id("model"),
                session_id: self.session_id.clone(),
                agent_id: self.agent_id.clone(),
                turn_id: self.turn_id.clone(),
                source_message_id: self.source_message_id.clone(),
                trace: request.trace.clone(),
                started_at: now_iso(),
                completed_at: None,
                elapsed_ms: None,
                status: ModelCallStatus::Running,
                request: None,
                estimated_input_tokens: miniq_agent::estimate_request_tokens(
                    &request.messages,
                    &request.tools,
                ),
                advertised_context_tokens: None,
                advertised_output_tokens: None,
                response: Default::default(),
                error: None,
            },
        };
        guard.save();
        match self.inner.execution_info(request.max_output_tokens).await {
            Ok(info) => guard.record.request = info,
            Err(error) => {
                guard.finish(ModelCallStatus::Failed, Some(&error));
                return Err(error);
            }
        }
        let limits = self.inner.capabilities().await;
        guard.record.advertised_context_tokens = limits.max_context_tokens;
        guard.record.advertised_output_tokens = limits.max_output_tokens;
        guard.save();
        match self.inner.stream_complete(request).await {
            Ok(inner) => Ok(Box::pin(ObservedStream { inner, guard })),
            Err(error) => {
                guard.finish(ModelCallStatus::Failed, Some(&error));
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests;
