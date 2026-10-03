//! Keeps a turn open while background child agents it started are running.
//!
//! A model may write a final-looking answer right after dispatching
//! `agent_run` with `runInBackground=true`. Reporting the turn as completed
//! at that point would mark the session idle while work is still running and
//! drop the children's results. Instead the turn waits for them and asks the
//! model to collect and reconcile their results before finishing.

use std::time::Duration;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::SessionToolExecutor;

/// One wait round. Longer waits continue in later rounds, each of which gives
/// the model a chance to report progress or stop children explicitly.
pub(crate) const BACKGROUND_SETTLE_TIMEOUT: Duration = Duration::from_secs(600);

impl SessionToolExecutor {
    pub(crate) async fn background_children_gate(
        &self,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Option<String> {
        let children = self
            .state
            .agent_tasks
            .settle_children(&self.session_id, self.owner_agent_id(), timeout, cancel)
            .await;
        if children.is_empty() || cancel.is_cancelled() {
            return None;
        }
        self.audit(
            "background_agents_pending_at_finish",
            json!({"agents": children.iter().map(|c| json!({
                "agentId": c["agentId"], "status": c["status"],
            })).collect::<Vec<_>>()}),
        );
        Some(instruction(&children))
    }
}

fn instruction(children: &[Value]) -> String {
    let still_running = children.iter().filter(|child| is_active(child)).count();
    let listing = children
        .iter()
        .map(|child| {
            format!(
                "- agentId={} name={} status={}{}",
                child["agentId"].as_str().unwrap_or_default(),
                child["name"].as_str().unwrap_or_default(),
                child["status"].as_str().unwrap_or_default(),
                child["error"]
                    .as_str()
                    .map(|error| format!(" error={error}"))
                    .unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let next = if still_running > 0 {
        format!(
            "{still_running} of them are still running. Do not report the task as complete. \
             Collect each result with process_output (id=agentId, block=true, timeoutSecs up to 600) \
             until every child has finished, or stop a child with process_kill only if it is \
             clearly stuck or no longer needed."
        )
    } else {
        "All of them have now finished. Collect each result with process_output (id=agentId) \
         before answering."
            .to_string()
    };
    format!(
        "[System notice] Your previous message was not delivered as the final answer because \
         background child agents started in this conversation were still running:\n{listing}\n\n\
         {next} Retry or redo failed work when it is required for the requested deliverable. \
         Then give the final answer based only on observed results, stating clearly anything \
         that failed or remains incomplete."
    )
}

fn is_active(child: &Value) -> bool {
    matches!(
        child["status"].as_str(),
        Some("running" | "stopping" | "finalizing")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instruction_lists_children_and_requires_collection() {
        let text = instruction(&[
            json!({"agentId": "agent_a", "name": "batch-1", "status": "completed"}),
            json!({"agentId": "agent_b", "name": "batch-2", "status": "running"}),
        ]);
        assert!(text.contains("agentId=agent_a name=batch-1 status=completed"));
        assert!(text.contains("agentId=agent_b name=batch-2 status=running"));
        assert!(text.contains("1 of them are still running"));
        assert!(text.contains("process_output"));
    }

    #[test]
    fn instruction_for_settled_children_asks_to_collect_results() {
        let text = instruction(&[json!({
            "agentId": "agent_a", "name": "batch-1", "status": "failed", "error": "boom"
        })]);
        assert!(text.contains("error=boom"));
        assert!(text.contains("All of them have now finished"));
    }
}
