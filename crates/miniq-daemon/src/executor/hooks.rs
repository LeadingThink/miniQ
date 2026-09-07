use miniq_models::ToolCallRequest;
use miniq_protocol::Event;
use serde_json::Value;

use super::SessionToolExecutor;

pub(super) fn after_success(
    executor: &SessionToolExecutor,
    call: &ToolCallRequest,
    output: &Value,
) {
    match call.name.as_str() {
        "task_update" => {
            let tasks: Vec<miniq_protocol::PlanTask> = call
                .arguments
                .get("tasks")
                .and_then(|tasks| serde_json::from_value(tasks.clone()).ok())
                .unwrap_or_default();
            publish_plan(executor, tasks, super::plan_review::ReviewPlan::Checklist);
        }
        "task_create" | "task_get" | "task_list" | "task_item_update" => {
            if let Some(tasks) = super::plan::task_graph_plan(output) {
                publish_plan(
                    executor,
                    tasks,
                    super::plan_review::ReviewPlan::Graph(output["tasks"].clone()),
                );
            }
        }
        "doc_write" => {
            let path = output.get("path").and_then(Value::as_str).unwrap_or("");
            let kind = output.get("kind").and_then(Value::as_str).unwrap_or("");
            let title = output.get("title").and_then(Value::as_str).unwrap_or(path);
            if let Ok(artifact) =
                executor
                    .state
                    .store
                    .create_artifact(&executor.session_id, path, kind, title)
            {
                executor.state.emit(Event::ArtifactCreated {
                    session_id: executor.session_id.clone(),
                    artifact,
                });
            }
        }
        _ => {}
    }
}

fn publish_plan(
    executor: &SessionToolExecutor,
    tasks: Vec<miniq_protocol::PlanTask>,
    source: super::plan_review::ReviewPlan,
) {
    // Child plans remain in their tool evidence; they must not replace the
    // parent's top-level checklist.
    if executor
        .ctx
        .agents
        .as_ref()
        .and_then(|bridge| bridge.owner_agent_id())
        .is_some()
    {
        return;
    }
    match executor
        .state
        .store
        .set_session_plan(&executor.session_id, &tasks)
    {
        Ok(()) => {
            *executor
                .review_plan
                .lock()
                .expect("plan review mutex poisoned") = Some(source);
            executor.state.emit(Event::PlanUpdated {
                session_id: executor.session_id.clone(),
                tasks,
            });
        }
        Err(error) => tracing::error!(%error, "could not persist the session plan"),
    }
}
