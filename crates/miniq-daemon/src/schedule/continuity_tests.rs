use super::*;
use miniq_models::{mock::MockProvider, ChatDelta};
use miniq_protocol::{Role, Session};
use serde_json::json;
use std::sync::Arc;

const DUE: &str = "2020-01-01T00:00:00Z";

fn setup(provider: Arc<MockProvider>) -> (AppState, tempfile::TempDir, Session) {
    let state = AppState::new(
        miniq_memory::Store::open_in_memory().unwrap(),
        "test".into(),
        provider,
    );
    let directory = tempfile::tempdir().unwrap();
    let workspace = state
        .store
        .create_workspace(directory.path().to_str().unwrap(), "project")
        .unwrap();
    let session = state
        .store
        .create_session(&workspace.id, "existing")
        .unwrap();
    (state, directory, session)
}

fn heartbeat(state: &AppState, session: &Session) -> ScheduledTask {
    state
        .store
        .create_scheduled_task(
            &session.workspace_id,
            "巡检",
            "继续检查未解决事项",
            &json!({"type":"interval","minutes":60}),
            DUE,
            ScheduledTaskMode::Heartbeat,
            Some(&session.id),
            "不重复汇报已解决事项",
        )
        .unwrap()
}

async fn completed(events: &mut tokio::sync::broadcast::Receiver<Event>, session: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if matches!(events.recv().await.unwrap(), Event::TurnCompleted { session_id } if session_id == session) { break; }
        }
    }).await.unwrap();
}

#[tokio::test]
async fn heartbeat_preserves_original_conversation_and_uses_its_own_memory() {
    let provider = Arc::new(MockProvider::new(vec![vec![ChatDelta::Text(
        "巡检完成".into(),
    )]]));
    let (state, _directory, session) = setup(provider.clone());
    let unrelated = state
        .store
        .create_session(&session.workspace_id, "unrelated")
        .unwrap();
    state
        .store
        .append_message(&session.id, Role::User, "原来的任务上下文")
        .unwrap();
    state
        .store
        .append_message(&unrelated.id, Role::User, "无关会话的内容")
        .unwrap();
    let task = heartbeat(&state, &session);
    let mut events = state.events.subscribe();
    assert_eq!(fire_task(&state, &task).unwrap(), session.id);
    completed(&mut events, &session.id).await;
    let messages = state.store.list_messages(&session.id).unwrap();
    assert_eq!(messages[0].content, "原来的任务上下文");
    assert!(
        messages
            .iter()
            .any(|message| message.content
                == "继续检查未解决事项\n\n任务记忆：\n不重复汇报已解决事项")
    );
    assert_eq!(state.store.list_messages(&unrelated.id).unwrap().len(), 1);
    assert_eq!(state.store.list_sessions(None).unwrap().len(), 2);
    assert_eq!(
        state
            .store
            .get_scheduled_task(&task.id)
            .unwrap()
            .last_session_id
            .as_deref(),
        Some(session.id.as_str())
    );
    let request = serde_json::to_string(&provider.requests.lock().unwrap()[0].messages).unwrap();
    assert!(request.contains("原来的任务上下文"));
    assert!(request.contains("不重复汇报已解决事项"));
    assert!(!request.contains("无关会话的内容"));
}

#[tokio::test]
async fn active_and_approval_sessions_are_skipped_without_interrupting() {
    let provider = Arc::new(MockProvider::new(Vec::new()));
    let (state, _directory, session) = setup(provider.clone());
    for status in [
        SessionStatus::Running,
        SessionStatus::WaitingApproval,
        SessionStatus::Cancelling,
    ] {
        state
            .store
            .update_session_status(&session.id, status)
            .unwrap();
        let task = heartbeat(&state, &session);
        run_due_tasks(&state).await;
        let saved = state.store.get_scheduled_task(&task.id).unwrap();
        assert!(saved.enabled);
        assert!(saved.next_run_at > miniq_memory::now_iso());
        assert!(saved.last_run_at.is_none());
        assert_eq!(state.store.get_session(&session.id).unwrap().status, status);
        assert!(state.store.list_messages(&session.id).unwrap().is_empty());
        state.store.delete_scheduled_task(&task.id).unwrap();
    }
    // Even before the persisted status changes, an active turn slot is enough
    // to prevent a second turn from being appended.
    state
        .store
        .update_session_status(&session.id, SessionStatus::Idle)
        .unwrap();
    let token = state.begin_turn(&session.id).unwrap();
    let task = heartbeat(&state, &session);
    assert!(fire_task(&state, &task).is_err());
    assert!(!token.is_cancelled());
    assert!(state.store.list_messages(&session.id).unwrap().is_empty());
    assert!(provider.requests.lock().unwrap().is_empty());
    state.end_turn(&session.id);
}

#[tokio::test]
async fn deleted_heartbeat_target_stays_paused_across_scheduler_ticks() {
    let provider = Arc::new(MockProvider::new(Vec::new()));
    let (state, _directory, session) = setup(provider);
    let task = heartbeat(&state, &session);
    state.store.delete_session(&session.id).unwrap();
    run_due_tasks(&state).await;
    let saved = state.store.get_scheduled_task(&task.id).unwrap();
    assert!(!saved.enabled);
    assert_eq!(saved.next_run_at, DUE);
    run_due_tasks(&state).await;
    assert!(!state.store.get_scheduled_task(&task.id).unwrap().enabled);
    assert!(state.store.list_sessions(None).unwrap().is_empty());
}

#[tokio::test]
async fn heartbeat_rejects_foreign_workspace_even_when_persisted_directly() {
    let provider = Arc::new(MockProvider::new(Vec::new()));
    let (state, _directory, session) = setup(provider.clone());
    let other_workspace = state.store.create_workspace("/other", "other").unwrap();
    let task = state
        .store
        .create_scheduled_task(
            &other_workspace.id,
            "invalid",
            "private prompt",
            &json!({"type":"interval","minutes":60}),
            DUE,
            ScheduledTaskMode::Heartbeat,
            Some(&session.id),
            "other project's memory",
        )
        .unwrap();
    assert!(fire_task(&state, &task).is_err());
    assert!(state.store.list_messages(&session.id).unwrap().is_empty());
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[test]
fn weekdays_skip_weekend_and_keep_local_time() {
    let offset = local_offset();
    let friday = time::macros::datetime!(2026-09-25 09:00:00 UTC).replace_offset(offset);
    let schedule = Schedule::Weekdays {
        weekdays: vec![1, 2, 3, 4, 5],
        time: ScheduleTime { hour: 9, minute: 0 },
    };
    let next = next_run_after(&schedule, friday).to_offset(offset);
    assert_eq!(next.weekday(), Weekday::Monday);
    assert_eq!((next.hour(), next.minute()), (9, 0));
    assert_eq!(next - friday, Duration::days(3));
    assert!(parse_schedule(&json!({"type":"weekdays","weekdays":[],"time":"09:00"})).is_err());
    assert!(parse_schedule(&json!({"type":"weekdays","weekdays":[8],"time":"09:00"})).is_err());
}
