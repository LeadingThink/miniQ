use futures_util::{stream::FuturesUnordered, StreamExt};
use miniq_models::{ChatMessage, ToolCallRequest};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{checkpoint::RunState, AgentError, RunLimits, ToolExecutionMode, ToolExecutor};

// Bound open files, document workers, and other local resources even when a
// model emits a very large batch. Serial calls remain ordering barriers.
const MAX_PARALLEL_CALLS: usize = 4;

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
    let mut index = 0;
    while index < calls.len() {
        if cancel.is_cancelled() {
            return Err(AgentError::Cancelled);
        }
        let call = &calls[index];
        if executor.execution_mode(call) == ToolExecutionMode::Sequential {
            state.history[base + index] = unfinished(call, true);
            state.save(limits, false).await?;
            let result = executor.execute(call).await?;
            state.history[base + index] = complete(executor, call, result);
            state.save(limits, false).await?;
            index += 1;
        } else {
            let end = index
                + calls[index..]
                    .iter()
                    .take_while(|call| executor.execution_mode(call) == ToolExecutionMode::Parallel)
                    .count();
            execute_parallel(
                executor,
                &calls[index..end],
                base + index,
                state,
                limits,
                cancel,
            )
            .await?;
            index = end;
        }
    }
    state.appended.extend_from_slice(&state.history[base..]);
    Ok(())
}

async fn run<'a>(
    executor: &'a dyn ToolExecutor,
    call: &'a ToolCallRequest,
    index: usize,
) -> (usize, &'a ToolCallRequest, Result<Value, AgentError>) {
    (index, call, executor.execute(call).await)
}

async fn execute_parallel(
    executor: &dyn ToolExecutor,
    calls: &[ToolCallRequest],
    base: usize,
    state: &mut RunState,
    limits: &RunLimits,
    cancel: &CancellationToken,
) -> Result<(), AgentError> {
    let mut pending = FuturesUnordered::new();
    let mut next = 0;
    let mut error = None;
    loop {
        while error.is_none()
            && !cancel.is_cancelled()
            && next < calls.len()
            && pending.len() < MAX_PARALLEL_CALLS
        {
            state.history[base + next] = unfinished(&calls[next], true);
            state.save(limits, false).await?;
            pending.push(run(executor, &calls[next], next));
            next += 1;
        }
        let Some((index, call, result)) = pending.next().await else {
            break;
        };
        match result {
            Ok(value) => state.history[base + index] = complete(executor, call, value),
            Err(cause) if error.is_none() => error = Some(cause),
            Err(_) => {}
        }
        // Drain already dispatched siblings after failure/cancellation and
        // checkpoint every success. Undispatched calls keep "not_started".
        state.save(limits, false).await?;
    }
    if let Some(error) = error {
        return Err(error);
    }
    if cancel.is_cancelled() {
        return Err(AgentError::Cancelled);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
