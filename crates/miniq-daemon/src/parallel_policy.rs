use miniq_models::{ChatMessage, ChatRole};

const POLICY_HEADER: &str = "miniQ execution policy: independent work first";

pub(crate) const PARALLEL_POLICY: &str = concat!(
    "miniQ execution policy: independent work first\n",
    "Prefer bounded parallel work when it preserves the same functionality, quality, completeness, ",
    "and permissions. At each step identify dependencies and shared resources before dispatch. ",
    "Batch independent read-only tool calls in the same model response so the harness can overlap ",
    "them; shell_batch runs commands sequentially and is not a parallel primitive.\n",
    "For substantial independent branches, use agent_run with runInBackground=true. Start a small ",
    "cohort (usually 2-4 workers), give each a distinct scope, exact input paths or record IDs, ",
    "the same evaluation criteria, an output format, and separate output files. Launch the cohort ",
    "before waiting for one result; do other independent work locally, then collect every required ",
    "result with process_output (id=agentId, block=true when waiting). Avoid rapid polling, duplicate work, ",
    "and recursive delegation of tiny tasks. Use direct tools when delegation overhead would dominate.\n",
    "Keep dependent steps, approvals, writes to shared files, shared browser tabs, and actions in ",
    "the same app or desktop control session sequential. For independent code edits, use separate ",
    "files or worktree isolation and integrate only after review. Respect explicit user limits and ",
    "provider/resource limits; reduce concurrency on throttling or resource pressure.\n",
    "For bulk document review such as resumes, enumerate all inputs first, partition by stable ",
    "IDs using a uniform rubric, and reconcile all inputs against the collected results. Do not ",
    "silently sample, truncate, omit failures, lower model quality, or skip validation for speed. ",
    "Preserve successful results and retry only failed independent work when appropriate. Verify ",
    "coverage, duplicates, consistency, and the combined deliverable before reporting completion."
);

/// Refresh on resume as well, without accumulating stale policy messages in
/// persisted child history. Task-specific instructions and evidence stay intact.
pub(crate) fn refresh_child_policy(history: &mut Vec<ChatMessage>) {
    history.retain(|message| {
        message.role != ChatRole::System || !message.content.starts_with(POLICY_HEADER)
    });
    history.insert(0, ChatMessage::system(PARALLEL_POLICY));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_children_keep_one_current_policy_and_all_task_evidence() {
        let mut history = vec![
            ChatMessage::system(format!("{POLICY_HEADER}\nobsolete policy")),
            ChatMessage::system("Task-specific constraints"),
            ChatMessage::user("Review every resume"),
            ChatMessage::tool_result("read-1", "Complete first resume"),
        ];
        refresh_child_policy(&mut history);
        refresh_child_policy(&mut history);
        assert_eq!(history.len(), 4);
        assert_eq!(history[0].content, PARALLEL_POLICY);
        assert_eq!(history[1].content, "Task-specific constraints");
        assert_eq!(history[2].content, "Review every resume");
        assert_eq!(history[3].content, "Complete first resume");
    }
}
