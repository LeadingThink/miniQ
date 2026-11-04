//! User-facing phase and retry timing from the shared protocol.
use miniq_protocol::{TurnPhase, TurnProgress};
use std::time::Duration;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub fn label(phase: &TurnPhase) -> &'static str {
    match phase {
        TurnPhase::PreparingContext => "Preparing context",
        TurnPhase::CompactingContext => "Compacting context",
        TurnPhase::RequestingModel => "Thinking",
        TurnPhase::ReceivingModel => "Responding",
        TurnPhase::WaitingRetry => "Waiting to retry",
        TurnPhase::Finalizing => "Finishing",
    }
}

pub fn elapsed(at: &str) -> Duration {
    OffsetDateTime::parse(at, &Rfc3339)
        .ok()
        .map(|at| {
            Duration::from_millis(
                (OffsetDateTime::now_utc() - at).whole_milliseconds().max(0) as u64
            )
        })
        .unwrap_or_default()
}

pub fn phase(progress: Option<&TurnProgress>, current: &str) -> String {
    let Some(progress) = progress.filter(|p| p.phase == TurnPhase::WaitingRetry) else {
        return current.into();
    };
    let Some(retry) = &progress.retry else {
        return label(&progress.phase).into();
    };
    let remaining =
        Duration::from_millis(retry.delay_ms).saturating_sub(elapsed(&progress.started_at));
    format!(
        "Retry {}/{} in {}s{}",
        retry.attempt,
        retry.max_attempts,
        remaining.as_millis().div_ceil(1000),
        retry
            .reason
            .as_ref()
            .map(|reason| format!(" · {reason}"))
            .unwrap_or_default()
    )
}
