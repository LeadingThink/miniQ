//! Pending prompt commits and explicit session stops share a short lock.
//! Submit hooks run outside the lock, using a token invalidated by a stop.

use std::collections::HashMap;
use std::sync::Mutex;

use miniq_protocol::{ErrorCode, RpcError};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct PromptSubmissions(Mutex<HashMap<String, SessionSubmissions>>);

struct SessionSubmissions {
    token: CancellationToken,
    pending: usize,
}

pub(crate) struct PendingPrompt<'a> {
    submissions: &'a PromptSubmissions,
    session_id: &'a str,
    token: CancellationToken,
}

impl PromptSubmissions {
    pub(crate) fn register<'a>(&'a self, session_id: &'a str) -> PendingPrompt<'a> {
        let mut sessions = self.0.lock().unwrap();
        let session = sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| SessionSubmissions {
                token: CancellationToken::new(),
                pending: 0,
            });
        session.pending += 1;
        PendingPrompt {
            submissions: self,
            session_id,
            token: session.token.clone(),
        }
    }

    pub(crate) fn synchronize<T>(&self, action: impl FnOnce() -> T) -> T {
        let _sessions = self.0.lock().unwrap();
        action()
    }

    pub(crate) fn cancel<T>(&self, session_id: &str, action: impl FnOnce() -> T) -> (bool, T) {
        let mut sessions = self.0.lock().unwrap();
        let pending = if let Some(session) = sessions.get_mut(session_id) {
            session.token.cancel();
            session.token = CancellationToken::new();
            session.pending > 0
        } else {
            false
        };
        (pending, action())
    }
}

impl PendingPrompt<'_> {
    pub(crate) fn token(&self) -> &CancellationToken {
        &self.token
    }

    pub(crate) fn commit<T>(
        &self,
        action: impl FnOnce() -> Result<T, RpcError>,
    ) -> Result<T, RpcError> {
        self.submissions.synchronize(|| {
            if self.token.is_cancelled() {
                return Err(RpcError::new(
                    ErrorCode::Cancelled,
                    "prompt cancelled before its task started",
                ));
            }
            action()
        })
    }
}

impl Drop for PendingPrompt<'_> {
    fn drop(&mut self) {
        let mut sessions = self.submissions.0.lock().unwrap();
        let Some(session) = sessions.get_mut(self.session_id) else {
            return;
        };
        session.pending -= 1;
        if session.pending == 0 {
            sessions.remove(self.session_id);
        }
    }
}
