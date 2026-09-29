use miniq_protocol::{TurnSummary, TurnSummaryStatus, TurnTiming, TurnTimingStatus};

use crate::state::AppState;

/// Builds the optional summary attached to `turn_completed` / `turn_failed`.
/// Returns `None` when the activity counts cannot be read; the terminal event
/// is still emitted without a summary.
pub(crate) fn build(
    state: &AppState,
    session_id: &str,
    timing: &TurnTiming,
) -> Option<TurnSummary> {
    let status = match timing.status {
        TurnTimingStatus::Completed => TurnSummaryStatus::Completed,
        TurnTimingStatus::Cancelled => TurnSummaryStatus::Cancelled,
        TurnTimingStatus::Failed => TurnSummaryStatus::Failed,
        TurnTimingStatus::Running | TurnTimingStatus::Interrupted => return None,
    };
    let activity = match state.store.turn_activity(session_id, &timing.started_at) {
        Ok(activity) => activity,
        Err(error) => {
            tracing::warn!(%session_id, %error, "failed to summarize turn activity");
            return None;
        }
    };
    Some(TurnSummary {
        status,
        tool_calls: activity.tool_calls,
        failed_tool_calls: activity.failed_tool_calls,
        files_changed: activity.files_changed,
        duration_ms: timing.elapsed_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::{Role, ToolCallStatus};
    use serde_json::json;

    #[test]
    fn summary_reports_status_counts_and_duration() {
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store.create_workspace("/tmp/turn-summary", "ws").unwrap();
        let session = store.create_session(&workspace.id, "s").unwrap();
        let state = AppState::new(
            store,
            "test".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        state
            .store
            .append_message(&session.id, Role::User, "task")
            .unwrap();
        let clock = crate::turn_clock::TurnClock::start(&state, &session.id).unwrap();
        let call = state
            .store
            .create_tool_call(
                &session.id,
                "write",
                &json!({}),
                None,
                ToolCallStatus::Running,
            )
            .unwrap();
        state
            .store
            .update_tool_call_status(&call.id, ToolCallStatus::Failed)
            .unwrap();
        state
            .store
            .create_checkpoint(
                &session.id,
                &call.id,
                "/tmp/turn-summary/a.txt",
                false,
                None,
            )
            .unwrap();
        let timing = clock.finish(&state, &session.id, TurnTimingStatus::Failed);

        let summary = build(&state, &session.id, &timing).unwrap();
        assert_eq!(summary.status, TurnSummaryStatus::Failed);
        assert_eq!(summary.tool_calls, 1);
        assert_eq!(summary.failed_tool_calls, 1);
        assert_eq!(summary.files_changed, 1);
        assert_eq!(summary.duration_ms, timing.elapsed_ms);
        assert!(summary.duration_ms.is_some());
    }
}
