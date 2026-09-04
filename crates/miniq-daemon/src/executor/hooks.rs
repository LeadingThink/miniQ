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
            executor
                .state
                .plans
                .lock()
                .unwrap()
                .insert(executor.session_id.clone(), tasks.clone());
            executor.state.emit(Event::PlanUpdated {
                session_id: executor.session_id.clone(),
                tasks,
            });
        }
        "task_create" | "task_get" | "task_list" | "task_item_update" => {
            if let Some(tasks) = super::plan::task_graph_plan(output) {
                executor
                    .state
                    .plans
                    .lock()
                    .unwrap()
                    .insert(executor.session_id.clone(), tasks.clone());
                executor.state.emit(Event::PlanUpdated {
                    session_id: executor.session_id.clone(),
                    tasks,
                });
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
