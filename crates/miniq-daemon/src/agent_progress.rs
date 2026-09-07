use miniq_agent::AgentEvent;
use miniq_protocol::{ModelRetryProgress, TurnPhase, TurnProgress};

pub(crate) fn from_event(event: AgentEvent) -> Option<TurnProgress> {
    let (phase, step, retry) = match event {
        AgentEvent::ModelRequestStarted { step } => (TurnPhase::RequestingModel, step, None),
        AgentEvent::ModelResponseStarted { step } => (TurnPhase::ReceivingModel, step, None),
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
