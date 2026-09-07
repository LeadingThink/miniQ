use miniq_agent::AgentEvent;
use miniq_protocol::{ModelRetryProgress, TurnPhase, TurnProgress};

pub(crate) fn from_event(event: AgentEvent) -> Option<TurnProgress> {
    let (phase, step, retry) = match event {
        AgentEvent::ModelRequestStarted { step, retry } => (
            if step == 0 {
                TurnPhase::CompactingContext
            } else {
                TurnPhase::RequestingModel
            },
            step,
            retry.map(in_flight_retry),
        ),
        AgentEvent::ModelResponseStarted { step, retry } => (
            if step == 0 {
                TurnPhase::CompactingContext
            } else {
                TurnPhase::ReceivingModel
            },
            step,
            retry.map(in_flight_retry),
        ),
        AgentEvent::ModelRetryScheduled {
            step,
            attempt,
            max_attempts,
            delay_ms,
        } => (
            TurnPhase::WaitingRetry,
            step,
            Some(ModelRetryProgress {
                attempt,
                max_attempts,
                delay_ms,
            }),
        ),
        _ => return None,
    };
    Some(TurnProgress {
        phase,
        model_step: (step > 0).then_some(step),
        started_at: miniq_memory::now_iso(),
        retry,
    })
}

fn in_flight_retry(retry: miniq_agent::RetryAttempt) -> ModelRetryProgress {
    ModelRetryProgress {
        attempt: retry.attempt,
        max_attempts: retry.max_attempts,
        delay_ms: 0,
    }
}

pub(crate) fn record_retry(
    state: &crate::state::AppState,
    session_id: &str,
    agent_id: Option<&str>,
    progress: &TurnProgress,
) {
    if progress.phase != TurnPhase::WaitingRetry {
        return;
    }
    let Some(retry) = &progress.retry else {
        return;
    };
    tracing::info!(
        session_id,
        agent_id,
        step = progress.model_step,
        attempt = retry.attempt,
        max_attempts = retry.max_attempts,
        delay_ms = retry.delay_ms,
        "model retry scheduled"
    );
    let payload = serde_json::json!({"agentId": agent_id, "progress": progress});
    if let Err(error) = state
        .store
        .append_audit_event(Some(session_id), "model_retry", &payload)
    {
        tracing::warn!(session_id, %error, "failed to record model retry audit");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_agent::RetryAttempt;

    #[test]
    fn retry_counts_survive_requests_responses_and_compaction_but_not_a_new_step() {
        for step in [0, 2] {
            for event in [
                AgentEvent::ModelRequestStarted {
                    step,
                    retry: Some(RetryAttempt {
                        attempt: 3,
                        max_attempts: 10,
                    }),
                },
                AgentEvent::ModelResponseStarted {
                    step,
                    retry: Some(RetryAttempt {
                        attempt: 3,
                        max_attempts: 10,
                    }),
                },
            ] {
                let progress = from_event(event).unwrap();
                let retry = progress.retry.unwrap();
                assert_eq!(
                    (retry.attempt, retry.max_attempts, retry.delay_ms),
                    (3, 10, 0)
                );
                if step == 0 {
                    assert_eq!(progress.phase, TurnPhase::CompactingContext);
                }
            }
        }
        assert!(from_event(AgentEvent::ModelRequestStarted {
            step: 3,
            retry: None
        })
        .unwrap()
        .retry
        .is_none());
    }

    #[test]
    fn audits_only_scheduled_retries_with_session_and_child_scope() {
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let state = crate::state::AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        let progress = from_event(AgentEvent::ModelRetryScheduled {
            step: 0,
            attempt: 1,
            max_attempts: 10,
            delay_ms: 1000,
        })
        .unwrap();
        record_retry(&state, "one", None, &progress);
        record_retry(&state, "two", Some("child"), &progress);
        let inflight = from_event(AgentEvent::ModelRequestStarted {
            step: 0,
            retry: Some(RetryAttempt {
                attempt: 1,
                max_attempts: 10,
            }),
        })
        .unwrap();
        record_retry(&state, "one", None, &inflight);
        assert_eq!(state.store.count_audit_events("one").unwrap(), 1);
        assert_eq!(state.store.count_audit_events("two").unwrap(), 1);
    }
}
