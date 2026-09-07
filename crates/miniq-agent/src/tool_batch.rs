use futures_util::{stream::FuturesUnordered, StreamExt};
use miniq_models::{ChatMessage, ToolCallRequest};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{checkpoint::RunState, AgentError, RunLimits, ToolExecutionMode, ToolExecutor};

fn unfinished(call: &ToolCallRequest, dispatched: bool) -> ChatMessage {
    ChatMessage::tool_result(call.id.clone(), json!({
        "interrupted": true,
        "execution": if dispatched { "unknown" } else { "not_started" },
        "message": if dispatched {
            "The turn ended without a confirmed result. Side effects may have happened. Inspect actual state before deciding whether to retry."
        } else {
            "This call was not dispatched. Follow the latest user request; do not automatically execute the previous request."
        },
    }).to_string())
}

fn complete(executor: &dyn ToolExecutor, call: &ToolCallRequest, result: Value) -> ChatMessage {
    let mut message = ChatMessage::tool_result(call.id.clone(), result.to_string());
    message.images = executor.result_images(call, &result);
    message
}

pub(crate) async fn execute(
    executor: &dyn ToolExecutor,
    calls: &[ToolCallRequest],
    state: &mut RunState,
    limits: &RunLimits,
    cancel: &CancellationToken,
) -> Result<(), AgentError> {
    let base = state.history.len();
    state
        .history
        .extend(calls.iter().map(|call| unfinished(call, false)));
    state.save(limits, false).await?;
    if cancel.is_cancelled() {
        return Err(AgentError::Cancelled);
    }
    if calls
        .iter()
        .all(|call| executor.execution_mode(call) == ToolExecutionMode::Parallel)
    {
        for (index, call) in calls.iter().enumerate() {
            state.history[base + index] = unfinished(call, true);
        }
        state.save(limits, false).await?;
        let mut results = calls
            .iter()
            .enumerate()
            .map(|(index, call)| async move { (index, call, executor.execute(call).await) })
            .collect::<FuturesUnordered<_>>();
        let mut error = None;
        // Preserve successes after a failed sibling too; the batch may contain side effects.
        while let Some((index, call, result)) = results.next().await {
            match result {
                Ok(value) => state.history[base + index] = complete(executor, call, value),
                Err(cause) if error.is_none() => error = Some(cause),
                Err(_) => {}
            }
            state.save(limits, false).await?;
        }
        if let Some(error) = error {
            return Err(error);
        }
    } else {
        for (index, call) in calls.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(AgentError::Cancelled);
            }
            state.history[base + index] = unfinished(call, true);
            state.save(limits, false).await?;
            let result = executor.execute(call).await?;
            state.history[base + index] = complete(executor, call, result);
            state.save(limits, false).await?;
        }
    }
    state.appended.extend_from_slice(&state.history[base..]);
    Ok(())
}
