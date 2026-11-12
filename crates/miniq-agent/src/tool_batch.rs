use futures_util::{stream::FuturesUnordered, StreamExt};
use miniq_models::{ChatMessage, ToolCallRequest};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{checkpoint::RunState, AgentError, RunLimits, ToolExecutionMode, ToolExecutor};

// Bound open files, document workers, and other local resources even when a
// model emits a very large batch. Serial calls remain ordering barriers.
const MAX_PARALLEL_CALLS: usize = 4;

pub(crate) fn unfinished(call: &ToolCallRequest, dispatched: bool) -> ChatMessage {
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

fn failed(call: &ToolCallRequest, error: AgentError) -> ChatMessage {
    ChatMessage::tool_result(
        call.id.clone(),
        json!({
            "error": error.to_string(),
            "execution": "failed",
            "message": "The tool failed. Keep the completed results from other calls, adjust the approach, and continue the task from the current state.",
        })
        .to_string(),
    )
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
    let mut index = 0;
    let mut unsaved_result = false;
    while index < calls.len() {
        if cancel.is_cancelled() {
            if unsaved_result {
                state.save(limits, false).await?;
            }
            return Err(AgentError::Cancelled);
        }
        let call = &calls[index];
        if executor.execution_mode(call) == ToolExecutionMode::Sequential {
            state.history[base + index] = unfinished(call, true);
            // The same durable snapshot records the previous result and the
            // next admission. No side effect starts before it succeeds.
            state.save(limits, false).await?;
            if cancel.is_cancelled() {
                return Err(AgentError::Cancelled);
            }
            state.history[base + index] = match executor.execute(call).await {
                Ok(result) => complete(executor, call, result),
                Err(AgentError::Cancelled) => return Err(AgentError::Cancelled),
                Err(error) => failed(call, error),
            };
            unsaved_result = true;
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
                unsaved_result,
            )
            .await?;
            unsaved_result = false;
            index = end;
        }
    }
    if unsaved_result {
        state.save(limits, false).await?;
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
    mut unsaved_result: bool,
) -> Result<(), AgentError> {
    let mut pending = FuturesUnordered::new();
    let mut next = 0;
    let mut error = None;
    loop {
        let available = MAX_PARALLEL_CALLS - pending.len();
        let end = if error.is_none() && !cancel.is_cancelled() {
            (next + available).min(calls.len())
        } else {
            next
        };
        for index in next..end {
            state.history[base + index] = unfinished(&calls[index], true);
        }
        if end > next || unsaved_result {
            // Admit a bounded group together, including any newly completed
            // result. Futures cannot execute until this snapshot is durable.
            state.save(limits, false).await?;
            unsaved_result = false;
        }
        while next < end && !cancel.is_cancelled() {
            pending.push(run(executor, &calls[next], next));
            next += 1;
        }
        let Some((index, call, result)) = pending.next().await else {
            break;
        };
        match result {
            Ok(value) => {
                state.history[base + index] = complete(executor, call, value);
                unsaved_result = true;
            }
            Err(AgentError::Cancelled) => error = Some(AgentError::Cancelled),
            Err(cause) => {
                state.history[base + index] = failed(call, cause);
                unsaved_result = true;
            }
        }
        // Drain already dispatched siblings after failure/cancellation and
        // checkpoint each result before awaiting another sibling or dispatch.
        // Calls outside the admitted group retain "not_started".
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
