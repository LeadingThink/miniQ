use std::time::Instant;

use miniq_protocol::{Event, TurnTiming, TurnTimingStatus};

use crate::state::AppState;

/// The whole execution clock is independent of model/phase progress. It
/// includes retries and tools, but starts only after leaving the message queue.
pub(crate) struct TurnClock {
    started: Instant,
    message_id: String,
    timing: TurnTiming,
}

impl TurnClock {
    pub(crate) fn start(state: &AppState, session_id: &str) -> Option<Self> {
        let started = Instant::now();
        match state.store.start_turn_timing(session_id) {
            Ok((message_id, timing)) => {
                state.emit(Event::TurnTimingChanged {
                    session_id: session_id.into(),
                    message_id: message_id.clone(),
                    timing: timing.clone(),
                });
                Some(Self {
                    started,
                    message_id,
                    timing,
                })
            }
            Err(error) => {
                tracing::error!(%session_id, %error, "failed to persist turn start time");
                None
            }
        }
    }

    pub(crate) fn finish(mut self, state: &AppState, session_id: &str, status: TurnTimingStatus) {
        self.timing.completed_at = Some(miniq_memory::now_iso());
        self.timing.elapsed_ms =
            Some(u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX));
        self.timing.status = status;
        match state
            .store
            .finish_turn_timing(session_id, &self.message_id, &self.timing)
        {
            Ok(()) => state.emit(Event::TurnTimingChanged {
                session_id: session_id.into(),
                message_id: self.message_id,
                timing: self.timing,
            }),
            Err(error) => tracing::error!(%session_id, %error, "failed to persist turn duration"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_timing_is_monotonic_and_survives_phase_changes_and_terminal_states() {
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/turn-clock", "timing").unwrap();
        let session = store.create_session(&workspace.id, "timing").unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        for status in [
            TurnTimingStatus::Completed,
            TurnTimingStatus::Failed,
            TurnTimingStatus::Cancelled,
        ] {
            let user = state
                .store
                .append_message(&session.id, miniq_protocol::Role::User, "task")
                .unwrap();
            let mut events = state.events.subscribe();
            let mut clock = TurnClock::start(&state, &session.id).unwrap();
            let Event::TurnTimingChanged {
                message_id, timing, ..
            } = events.try_recv().unwrap()
            else {
                panic!("expected turn start event")
            };
            assert_eq!(message_id, user.id);
            assert_eq!(timing.status, TurnTimingStatus::Running);
            // A wall-clock adjustment cannot change the elapsed measurement.
            clock.started -= std::time::Duration::from_millis(1_500);
            clock.timing.started_at = "2099-01-01T00:00:00Z".into();
            state.set_turn_progress(
                &session.id,
                miniq_protocol::TurnPhase::WaitingRetry,
                Some(2),
            );
            state.set_turn_progress(
                &session.id,
                miniq_protocol::TurnPhase::ReceivingModel,
                Some(2),
            );
            clock.finish(&state, &session.id, status);
            let measured = state
                .store
                .latest_turn_timing(&session.id)
                .unwrap()
                .unwrap()
                .timing;
            assert_eq!(measured.status, status);
            assert!((1_500..60_000).contains(&measured.elapsed_ms.unwrap()));
            assert!(measured.completed_at.is_some());
        }
    }
}
