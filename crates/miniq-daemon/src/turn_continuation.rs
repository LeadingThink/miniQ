//! Keeps a turn open while work it started is still unfinished.
//!
//! A model ends a turn by answering without tool calls. That is right for a
//! finished task, but the same shape appears after one intermediate status
//! line of a long task: the checklist still has a step in progress, or a
//! background command started in this turn has not reported a terminal status.
//! The daemon then asks the model to keep working instead of reporting a
//! finished turn, bounded by a per-turn continuation budget.

use std::collections::BTreeMap;

use miniq_protocol::{PlanTask, PlanTaskStatus};
use serde_json::Value;

use crate::state::AppState;

/// Continuations one turn may take beyond its first text-only answer.
///
/// Only a stop while work is underway consumes budget; a turn that keeps
/// calling tools never reaches this limit. Four rounds are enough to collect a
/// long build or test run and finish the step it blocks, and they keep an
/// honestly blocked task from looping on tokens.
pub(crate) const MAX_CONTINUATIONS: usize = 4;

/// Per-turn continuation bookkeeping for one session-and-agent scope.
#[derive(Debug, Default)]
pub(crate) struct TurnContinuation {
    used: usize,
    /// Processes started in this turn that have not reported a terminal status,
    /// keyed by process id and carrying the command for the reminder text.
    running: BTreeMap<String, String>,
}

/// Why the turn must continue.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    /// Background processes this turn started are still running.
    Process(Vec<(String, String)>),
    /// Checklist steps this turn published are still in progress.
    Checklist(Vec<String>),
}

impl Reason {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Process(_) => "background_process",
            Self::Checklist(_) => "checklist",
        }
    }
}

/// Scope key: one turn per session for the root agent, per child for a subagent.
pub(crate) fn key(session_id: &str, agent_id: Option<&str>) -> String {
    format!("{}:{}", session_id, agent_id.unwrap_or("root"))
}

/// Start a turn: forget the previous budget and process set for this scope.
pub(crate) fn begin(state: &AppState, key: &str) {
    state
        .turn_continuations
        .lock()
        .expect("turn continuation mutex poisoned")
        .insert(key.to_string(), TurnContinuation::default());
}

/// Release the scope when the turn ends so a long-lived daemon holds nothing.
pub(crate) fn end(state: &AppState, key: &str) {
    state
        .turn_continuations
        .lock()
        .expect("turn continuation mutex poisoned")
        .remove(key);
}

fn snapshot(state: &AppState, key: &str) -> TurnContinuation {
    state
        .turn_continuations
        .lock()
        .expect("turn continuation mutex poisoned")
        .get(key)
        .map(|entry| TurnContinuation {
            used: entry.used,
            running: entry.running.clone(),
        })
        .unwrap_or_default()
}

/// Record one process status a shell tool just reported.
///
/// Only a launcher admits a process, so polling an older command (a dev server
/// started in an earlier turn) never holds this turn open. Terminal statuses
/// always forget the process, so a polled or killed command releases the turn.
pub(crate) fn note_process(state: &AppState, key: &str, launched: bool, output: &Value) {
    let Some(id) = output.get("shellId").and_then(Value::as_str) else {
        return;
    };
    let status = output.get("status").and_then(Value::as_str).unwrap_or("");
    let command = output
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut entries = state
        .turn_continuations
        .lock()
        .expect("turn continuation mutex poisoned");
    let entry = entries.entry(key.to_string()).or_default();
    if status != "running" {
        entry.running.remove(id);
    } else if launched {
        entry.running.insert(id.to_string(), command.to_string());
    }
}

/// Charge one continuation against the budget.
///
/// Returns the new count, or `None` when the budget is exhausted and the turn
/// must be allowed to finish.
fn consume(state: &AppState, key: &str, limit: usize) -> Option<usize> {
    let mut entries = state
        .turn_continuations
        .lock()
        .expect("turn continuation mutex poisoned");
    let entry = entries.entry(key.to_string()).or_default();
    if entry.used >= limit {
        return None;
    }
    entry.used += 1;
    Some(entry.used)
}

/// Decide whether this turn stopped while work it owns is still underway.
///
/// Both signals are observations, not narration: a process reported `running`,
/// or a checklist step this turn published is still `in_progress`. A plan that
/// merely has pending steps does not hold the turn open, so a task the user
/// deliberately defers can still finish. Once the model has already been asked
/// to continue in this turn, any unfinished step holds it open: by then it is
/// mid-task by its own account, and demoting a step back to `pending` is not a
/// completion.
pub(crate) fn decide(
    plan: &[PlanTask],
    plan_published: bool,
    continued: bool,
    running: &BTreeMap<String, String>,
) -> Option<Reason> {
    if !running.is_empty() {
        return Some(Reason::Process(
            running
                .iter()
                .map(|(id, command)| (id.clone(), command.clone()))
                .collect(),
        ));
    }
    if !plan_published {
        return None;
    }
    let unfinished = plan
        .iter()
        .filter(|task| match task.status {
            PlanTaskStatus::Completed => false,
            PlanTaskStatus::InProgress => true,
            PlanTaskStatus::Pending => continued,
        })
        .map(|task| task.content.clone())
        .collect::<Vec<_>>();
    (!unfinished.is_empty()).then_some(Reason::Checklist(unfinished))
}

/// The model-visible instruction that keeps the turn going.
pub(crate) fn instruction(reason: &Reason, used: usize, limit: usize) -> String {
    let mut detail = String::new();
    match reason {
        Reason::Process(processes) => {
            detail.push_str("Background processes started in this turn are still running:\n");
            for (id, command) in processes {
                detail.push_str(&format!("- shellId={id} command={command}\n"));
            }
        }
        Reason::Checklist(active) => {
            detail.push_str("Checklist steps still unfinished:\n");
            for content in active {
                detail.push_str(&format!("- {content}\n"));
            }
        }
    }
    format!(
        "[miniQ turn continuation]\nThis answer is interim: work started in this turn is \
         unfinished, so the turn continues.\n\n{detail}\nContinue now, in this same turn.\n\
         1. Collect every listed process with process_output (yieldTimeMs or timeoutSecs, up to \
         600) and act on its real output. If a process already exited, use the recorded result \
         instead of starting the command again.\n\
         2. Do the next unfinished step and verify it with observed evidence.\n\
         3. Keep a step in_progress while you work on it, and mark it completed only with \
         evidence from this turn.\n\
         4. Never end a turn while a background process you started is still running; stop one \
         with process_kill when it is no longer needed and say why.\n\n\
         If the remaining work genuinely needs the user, stop the processes you no longer need, \
         state exactly what you need, and leave the step in progress. This turn has continued \
         {used} of {limit} allowed times.\n"
    )
}

impl crate::executor::SessionToolExecutor {
    /// Ask the model to keep working when this turn stopped with work underway.
    ///
    /// `None` lets the turn finish: nothing is underway, the model published no
    /// checklist in this turn, or the continuation budget is spent.
    pub(crate) fn continuation_instruction(&self) -> Option<String> {
        let key = key(&self.session_id, self.owner_agent_id());
        let published = self
            .review_plan
            .lock()
            .expect("plan review mutex poisoned")
            .is_some();
        let plan = self
            .state
            .store
            .session_plan(&self.session_id)
            .unwrap_or_default();
        let entry = snapshot(&self.state, &key);
        let reason = decide(&plan, published, entry.used > 0, &entry.running)?;
        let Some(used) = consume(&self.state, &key, MAX_CONTINUATIONS) else {
            self.audit(
                "turn_continuation_limit",
                serde_json::json!({"reason": reason.kind(), "limit": MAX_CONTINUATIONS}),
            );
            return None;
        };
        self.audit(
            "turn_continued",
            serde_json::json!({"continuations": used, "reason": reason.kind()}),
        );
        Some(instruction(&reason, used, MAX_CONTINUATIONS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_models::mock::MockProvider;
    use std::sync::Arc;

    fn task(content: &str, status: PlanTaskStatus) -> PlanTask {
        PlanTask {
            content: content.into(),
            status,
        }
    }

    fn state() -> AppState {
        let store = miniq_memory::Store::open_in_memory().unwrap();
        AppState::new(
            store,
            "test-token".into(),
            Arc::new(MockProvider::new(Vec::new())),
        )
    }

    #[test]
    fn a_running_process_holds_the_turn_open() {
        let mut running = BTreeMap::new();
        running.insert("shell_1".to_string(), "npx vue-tsc".to_string());
        let plan = [
            task("merge", PlanTaskStatus::Completed),
            task("typecheck", PlanTaskStatus::Pending),
        ];
        assert_eq!(
            decide(&plan, true, false, &running),
            Some(Reason::Process(vec![(
                "shell_1".into(),
                "npx vue-tsc".into()
            )]))
        );
    }

    #[test]
    fn an_in_progress_step_of_this_turn_holds_the_turn_open() {
        let plan = [
            task("merge", PlanTaskStatus::Completed),
            task("typecheck", PlanTaskStatus::InProgress),
        ];
        assert_eq!(
            decide(&plan, true, false, &BTreeMap::new()),
            Some(Reason::Checklist(vec!["typecheck".into()]))
        );
    }

    #[test]
    fn a_finished_or_foreign_plan_lets_the_turn_end() {
        let done = [task("merge", PlanTaskStatus::Completed)];
        assert_eq!(decide(&done, true, false, &BTreeMap::new()), None);
        // Pending steps alone are a deferral, not work underway.
        let deferred = [task("deploy", PlanTaskStatus::Pending)];
        assert_eq!(decide(&deferred, true, false, &BTreeMap::new()), None);
        // A plan this turn did not publish belongs to earlier work.
        let inherited = [task("deploy", PlanTaskStatus::InProgress)];
        assert_eq!(decide(&inherited, false, false, &BTreeMap::new()), None);
    }

    #[test]
    fn after_one_continuation_a_pending_step_still_holds_the_turn() {
        let plan = [
            task("merge", PlanTaskStatus::Completed),
            task("typecheck", PlanTaskStatus::Pending),
        ];
        assert_eq!(
            decide(&plan, true, true, &BTreeMap::new()),
            Some(Reason::Checklist(vec!["typecheck".into()]))
        );
        // Completed work still ends it.
        let done = [task("merge", PlanTaskStatus::Completed)];
        assert_eq!(decide(&done, true, true, &BTreeMap::new()), None);
    }

    #[test]
    fn the_instruction_names_the_work_and_the_budget() {
        let text = instruction(
            &Reason::Checklist(vec!["typecheck".into()]),
            1,
            MAX_CONTINUATIONS,
        );
        assert!(text.contains("Checklist steps still unfinished"));
        assert!(text.contains("- typecheck"));
        assert!(text.contains("process_output"));
        assert!(text.contains("1 of 4"));

        let text = instruction(
            &Reason::Process(vec![("shell_1".into(), "pytest".into())]),
            2,
            MAX_CONTINUATIONS,
        );
        assert!(text.contains("shellId=shell_1 command=pytest"));
        assert!(text.contains("2 of 4"));
    }

    #[test]
    fn a_launched_process_holds_the_turn_until_it_reports_a_status() {
        let state = state();
        let key = key("session", None);
        begin(&state, &key);
        note_process(
            &state,
            &key,
            true,
            &serde_json::json!({"shellId": "shell_1", "status": "running", "command": "pytest"}),
        );
        assert_eq!(
            snapshot(&state, &key).running.len(),
            1,
            "a background command this turn started must hold the turn open"
        );
        note_process(
            &state,
            &key,
            false,
            &serde_json::json!({"shellId": "shell_1", "status": "completed", "command": "pytest"}),
        );
        assert!(snapshot(&state, &key).running.is_empty());
        end(&state, &key);
    }

    #[test]
    fn polling_an_older_process_never_holds_the_turn_open() {
        let state = state();
        let key = key("session", None);
        begin(&state, &key);
        note_process(
            &state,
            &key,
            false,
            &serde_json::json!({"shellId": "shell_old", "status": "running", "command": "npm dev"}),
        );
        assert!(snapshot(&state, &key).running.is_empty());
    }

    #[test]
    fn the_budget_is_spent_once_per_continuation_and_bounded() {
        let state = state();
        let key = key("session", None);
        begin(&state, &key);
        for expected in 1..=MAX_CONTINUATIONS {
            assert_eq!(consume(&state, &key, MAX_CONTINUATIONS), Some(expected));
        }
        assert_eq!(consume(&state, &key, MAX_CONTINUATIONS), None);
        // A new turn starts with a fresh budget.
        begin(&state, &key);
        assert_eq!(consume(&state, &key, MAX_CONTINUATIONS), Some(1));
    }
}
