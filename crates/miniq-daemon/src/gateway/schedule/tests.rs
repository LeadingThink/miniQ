use super::*;
use miniq_memory::Store;
use miniq_models::mock::MockProvider;
use std::sync::Arc;

fn setup() -> (AppState, String, String, String) {
    let store = Store::open_in_memory().unwrap();
    let project = store.create_workspace("/schedule-a", "A").unwrap();
    let other = store.create_workspace("/schedule-b", "B").unwrap();
    let session = store.create_session(&project.id, "目标会话").unwrap();
    (
        AppState::new(store, "token".into(), Arc::new(MockProvider::text("ok"))),
        project.id,
        other.id,
        session.id,
    )
}

fn input(workspace: &str, target: Value) -> Value {
    json!({
        "workspaceId": workspace, "name": "持续检查", "prompt": "检查变化",
        "mode": "heartbeat", "targetSessionId": target,
        "memory": "仅检查 A 项目", "schedule": {"type": "interval", "minutes": 60},
    })
}

#[test]
fn heartbeat_configuration_rejects_missing_cross_project_and_archived_targets() {
    let (state, workspace, other, session) = setup();
    for target in [Value::Null, json!(""), json!("missing")] {
        let error = create(&state, Some(input(&workspace, target))).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams as i64);
    }
    assert!(create(&state, Some(input(&other, json!(session)))).is_err());
    state.store.set_session_archived(&session, true).unwrap();
    assert!(create(&state, Some(input(&workspace, json!(session)))).is_err());
    assert!(state.store.list_scheduled_tasks().unwrap().is_empty());
}

#[test]
fn target_is_normalized_and_invalid_update_cannot_move_task_memory() {
    let (state, workspace, other, session) = setup();
    let created = create(
        &state,
        Some(input(&workspace, json!(format!("  {session}  ")))),
    )
    .unwrap();
    assert_eq!(created["targetSessionId"], session);
    let id = created["id"].as_str().unwrap();
    let mut change = input(&other, json!(session));
    change["id"] = json!(id);
    assert!(update(&state, Some(change)).is_err());
    let preserved = state.store.get_scheduled_task(id).unwrap();
    assert_eq!(preserved.workspace_id, workspace);
    assert_eq!(preserved.memory, "仅检查 A 项目");
    assert_eq!(
        preserved.target_session_id.as_deref(),
        Some(session.as_str())
    );
    assert_eq!(state.store.list_scheduled_tasks().unwrap().len(), 1);
}

#[test]
fn edits_keep_disabled_state_and_reenable_validates_the_target() {
    let (state, workspace, _, session) = setup();
    let created = create(&state, Some(input(&workspace, json!(session)))).unwrap();
    let id = created["id"].as_str().unwrap();
    toggle(&state, Some(json!({"id": id, "enabled": false}))).unwrap();
    let mut change = input(&workspace, json!(session));
    change["id"] = json!(id);
    change["name"] = json!("工作日巡检");
    change["schedule"] = json!({"type":"weekdays", "weekdays":[1,3,5], "time":"10:30"});
    let edited = update(&state, Some(change)).unwrap();
    assert_eq!(edited["name"], "工作日巡检");
    assert_eq!(edited["enabled"], false);
    state.store.set_session_archived(&session, true).unwrap();
    assert!(toggle(&state, Some(json!({"id":id,"enabled":true}))).is_err());
    assert!(!state.store.get_scheduled_task(id).unwrap().enabled);
}
