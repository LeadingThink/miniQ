//! A prompt owns its turn slot while asynchronous submit hooks are running.

use miniq_protocol::{Event, SessionStatus};
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

pub(super) struct PromptAdmission<'a> {
    state: &'a AppState,
    session_id: &'a str,
    token: Option<CancellationToken>,
}

impl<'a> PromptAdmission<'a> {
    pub(super) fn reserve(state: &'a AppState, session_id: &'a str) -> Option<Self> {
        state.begin_turn(session_id).map(|token| Self {
            state,
            session_id,
            token: Some(token),
        })
    }

    pub(super) fn token(&self) -> &CancellationToken {
        self.token.as_ref().expect("prompt owns an unstarted turn")
    }

    pub(super) fn start(mut self) -> CancellationToken {
        self.token.take().expect("prompt owns an unstarted turn")
    }

    fn release(&self, token: &CancellationToken) {
        if token.is_cancelled() {
            // No executor started. Keep the last turn's durable outcome.
            if let Err(error) = self
                .state
                .store
                .update_session_status(self.session_id, SessionStatus::Idle)
            {
                tracing::error!(%error, session_id = self.session_id, "could not settle a cancelled prompt");
            }
            self.state.emit(Event::SessionStatusChanged {
                session_id: self.session_id.to_owned(),
                status: SessionStatus::Idle,
            });
        }
        self.state.end_turn(self.session_id);
        crate::turn::start_next_queued(self.state, self.session_id);
    }
}

impl Drop for PromptAdmission<'_> {
    fn drop(&mut self) {
        let Some(token) = &self.token else { return };
        self.state
            .prompt_submissions
            .synchronize(|| self.release(token));
    }
}
