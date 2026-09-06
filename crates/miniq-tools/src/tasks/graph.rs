//! Validate the complete proposed graph before publishing any mutations.

use std::collections::{BTreeMap, VecDeque};

use super::{TaskBoard, ToolError};

pub(super) fn validate(board: &TaskBoard) -> Result<(), ToolError> {
    let mut remaining = board
        .tasks
        .values()
        .map(|task| (task.id.as_str(), task.blocked_by.len()))
        .collect::<BTreeMap<_, _>>();
    let mut ready = remaining
        .iter()
        .filter_map(|(&id, &count)| (count == 0).then_some(id))
        .collect::<VecDeque<_>>();
    let mut visited = 0;
    while let Some(id) = ready.pop_front() {
        visited += 1;
        for dependent in &board.tasks[id].blocks {
            let count = remaining.get_mut(dependent.as_str()).unwrap();
            *count -= 1;
            if *count == 0 {
                ready.push_back(dependent);
            }
        }
    }
    if visited != board.tasks.len() {
        return Err(ToolError::InvalidInput(
            "task dependencies contain a cycle".into(),
        ));
    }
    for task in board.tasks.values() {
        if !matches!(task.status.as_str(), "in_progress" | "completed") {
            continue;
        }
        let unfinished = task
            .blocked_by
            .iter()
            .filter(|id| board.tasks[*id].status != "completed")
            .cloned()
            .collect::<Vec<_>>();
        if !unfinished.is_empty() {
            return Err(ToolError::InvalidInput(format!(
                "task {} cannot be {} while blockers are unfinished: {}",
                task.id,
                task.status,
                unfinished.join(", ")
            )));
        }
    }
    Ok(())
}
