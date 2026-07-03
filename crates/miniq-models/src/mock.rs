//! Mock provider for tests: scripted responses, no network.

use std::sync::Mutex;

use async_trait::async_trait;
use futures_util::stream;

use crate::provider::{
    ChatDelta, CompletionRequest, DeltaStream, ModelProvider, ProviderError,
};

/// One scripted turn: the deltas the provider will emit (a trailing
/// `Finished` is appended automatically).
pub type ScriptedTurn = Vec<ChatDelta>;

/// Emits pre-scripted turns in order. Panics if asked for more turns than
/// scripted — tests should script exactly what they expect.
pub struct MockProvider {
    turns: Mutex<std::vec::IntoIter<ScriptedTurn>>,
    /// Captured requests for assertions.
    pub requests: Mutex<Vec<CompletionRequest>>,
}

impl MockProvider {
    pub fn new(turns: Vec<ScriptedTurn>) -> Self {
        Self {
            turns: Mutex::new(turns.into_iter()),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// Single-turn provider that streams `text` split into small chunks.
    pub fn text(text: &str) -> Self {
        let deltas = text
            .split_inclusive(' ')
            .map(|part| ChatDelta::Text(part.to_string()))
            .collect();
        Self::new(vec![deltas])
    }
}

#[async_trait]
impl ModelProvider for MockProvider {
    async fn stream_complete(
        &self,
        request: CompletionRequest,
    ) -> Result<DeltaStream, ProviderError> {
        self.requests.lock().unwrap().push(request);
        let turn = self
            .turns
            .lock()
            .unwrap()
            .next()
            .ok_or_else(|| ProviderError::Config("mock provider has no more scripted turns".into()))?;
        let mut items: Vec<Result<ChatDelta, ProviderError>> =
            turn.into_iter().map(Ok).collect();
        items.push(Ok(ChatDelta::Finished));
        Ok(Box::pin(stream::iter(items)))
    }

    fn describe(&self) -> String {
        "mock".to_string()
    }
}
