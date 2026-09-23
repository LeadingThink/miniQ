use super::*;
use miniq_protocol::SessionStatus;
use std::sync::{Arc, Barrier};

const DUE: &str = "2020-01-01T00:00:00Z";
const NEXT: &str = "2099-01-01T00:00:00Z";

fn task(store: &Store, workspace: &str) -> ScheduledTask {
    store
        .create_scheduled_task(
            workspace,
            "巡检",
            "检查项目",
            &serde_json::json!({"type":"interval","minutes":60}),
            DUE,
            ScheduledTaskMode::NewSession,
            None,
            "只关注阻塞项",
        )
        .unwrap()
}

#[test]
fn legacy_tasks_keep_schedule_and_default_to_new_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("legacy.db");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
        )
        .unwrap();
    for (name, sql) in super::super::MIGRATIONS
        .iter()
        .take_while(|(name, _)| *name != "0016_scheduled_task_continuity")
    {
        connection.execute_batch(sql).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations VALUES (?1, 'now')",
                params![name],
            )
            .unwrap();
    }
    connection.execute_batch(r#"
        INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES ('w', '/existing', 'project', 'now', 'now');
        INSERT INTO scheduled_tasks (id, workspace_id, name, prompt, schedule, enabled, next_run_at, last_run_at, last_session_id, created_at)
        VALUES ('old-task', 'w', '每日简报', '完整保留的指令', '{"type":"daily","time":"09:00"}', 0, '2026-09-23T01:00:00Z', 'yesterday', 'last-session', 'original-time');
    "#).unwrap();
    drop(connection);
    let store = Store::open(&database).unwrap();
    let task = store.get_scheduled_task("old-task").unwrap();
    assert_eq!(task.mode, ScheduledTaskMode::NewSession);
    assert_eq!(task.target_session_id, None);
    assert!(task.memory.is_empty());
    assert_eq!(task.prompt, "完整保留的指令");
    assert!(!task.enabled);
    assert_eq!(task.last_session_id.as_deref(), Some("last-session"));
    assert_eq!(task.next_run_at, "2026-09-23T01:00:00Z");
    assert_eq!(task.created_at, "original-time");
    assert_eq!(store.list_scheduled_tasks().unwrap().len(), 1);
    // Opening an upgraded database again must not duplicate/reapply the schema.
    drop(store);
    assert_eq!(
        Store::open(&database)
            .unwrap()
            .list_scheduled_tasks()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn manual_and_due_dispatch_share_one_atomic_claim() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let workspace = store.create_workspace("/scheduler", "schedule").unwrap();
    let task = task(&store, &workspace.id);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [None, Some(DUE)]
        .into_iter()
        .map(|due| {
            let store = store.clone();
            let id = task.id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.claim_scheduled_task(&id, due).unwrap()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .filter_map(|thread| thread.join().unwrap().then_some(()))
            .count(),
        1
    );
    assert!(!store.claim_scheduled_task(&task.id, None).unwrap());
    store.recover_scheduled_task_claims().unwrap();
    assert!(store.claim_scheduled_task(&task.id, None).unwrap());
    store.release_scheduled_task(&task.id).unwrap();
    store
        .set_scheduled_task_enabled(&task.id, false, None)
        .unwrap();
    assert!(!store.claim_scheduled_task(&task.id, Some(DUE)).unwrap());
    assert!(
        store.claim_scheduled_task(&task.id, None).unwrap(),
        "a paused task can be run manually"
    );
}

#[test]
fn run_record_and_message_are_atomic_and_prevent_overlapping_runs() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/scheduler", "schedule").unwrap();
    let task = task(&store, &workspace.id);
    let session = store.create_session(&workspace.id, "result").unwrap();
    assert!(store.claim_scheduled_task(&task.id, Some(DUE)).unwrap());
    store
        .start_scheduled_task_run(&task.id, &session.id, "本次指令", NEXT)
        .unwrap();
    assert_eq!(
        store.list_messages(&session.id).unwrap()[0].content,
        "本次指令"
    );
    let task = store.get_scheduled_task(&task.id).unwrap();
    assert_eq!(task.last_session_id.as_deref(), Some(session.id.as_str()));
    assert_eq!(task.next_run_at, NEXT);
    for status in [
        SessionStatus::Running,
        SessionStatus::WaitingApproval,
        SessionStatus::Cancelling,
    ] {
        store.update_session_status(&session.id, status).unwrap();
        // New-session schedules are independent occurrences: an earlier run
        // may still be active while a later occurrence gets its own session.
        assert!(store.claim_scheduled_task(&task.id, None).unwrap());
        store.release_scheduled_task(&task.id).unwrap();
    }
    store
        .update_session_status(&session.id, SessionStatus::Idle)
        .unwrap();
    assert!(
        !store.claim_scheduled_task(&task.id, Some(DUE)).unwrap(),
        "a stale tick cannot replay the committed run"
    );
    assert!(store.claim_scheduled_task(&task.id, None).unwrap());
    assert!(store
        .start_scheduled_task_run(&task.id, "missing-session", "must rollback", NEXT)
        .is_err());
    assert_eq!(
        store
            .get_scheduled_task(&task.id)
            .unwrap()
            .last_session_id
            .as_deref(),
        Some(session.id.as_str())
    );
    assert_eq!(store.list_messages(&session.id).unwrap().len(), 1);
}

#[test]
fn skipped_occurrences_keep_reason_without_creating_a_session() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace("/scheduler-skip", "schedule")
        .unwrap();
    let task = task(&store, &workspace.id);
    store
        .record_scheduled_task_skip(&task.id, "target is still running")
        .unwrap();
    let runs = store
        .list_scheduled_task_runs(&task.id, None, 20)
        .unwrap()
        .runs;
    assert_eq!(runs.len(), 1);
    assert_eq!(
        runs[0].status,
        miniq_protocol::ScheduledTaskRunStatus::Skipped
    );
    assert_eq!(runs[0].session_id, None);
    assert_eq!(runs[0].reason.as_deref(), Some("target is still running"));
    assert!(runs[0].completed_at.is_some());
}

#[test]
fn deferral_never_reenables_or_overwrites_another_run() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/scheduler", "schedule").unwrap();
    let task = task(&store, &workspace.id);
    store
        .set_scheduled_task_enabled(&task.id, false, None)
        .unwrap();
    store.defer_scheduled_task(&task.id, DUE, NEXT).unwrap();
    let saved = store.get_scheduled_task(&task.id).unwrap();
    assert!(!saved.enabled);
    assert_eq!(saved.next_run_at, DUE);
    store
        .set_scheduled_task_enabled(&task.id, true, Some(NEXT))
        .unwrap();
    store
        .defer_scheduled_task(&task.id, DUE, "2098-01-01T00:00:00Z")
        .unwrap();
    assert_eq!(
        store.get_scheduled_task(&task.id).unwrap().next_run_at,
        NEXT
    );
}

#[test]
fn task_memory_edits_are_persistent_and_scoped_to_task() {
    let store = Store::open_in_memory().unwrap();
    let first_workspace = store.create_workspace("/first", "first").unwrap();
    let second_workspace = store.create_workspace("/second", "second").unwrap();
    let first = task(&store, &first_workspace.id);
    let second = task(&store, &second_workspace.id);
    store
        .update_scheduled_task(
            &first.id,
            &first.workspace_id,
            "新标题",
            "新指令",
            &first.schedule,
            first.mode,
            None,
            "第一项目的专用记忆",
            NEXT,
        )
        .unwrap();
    assert_eq!(
        store.get_scheduled_task(&first.id).unwrap().memory,
        "第一项目的专用记忆"
    );
    let unchanged = store.get_scheduled_task(&second.id).unwrap();
    assert_eq!(unchanged.memory, "只关注阻塞项");
    assert_eq!(unchanged.prompt, "检查项目");
}

#[test]
fn claimed_tasks_reject_edits_and_cross_session_dispatch() {
    let store = Store::open_in_memory().unwrap();
    let workspace = store.create_workspace("/first", "first").unwrap();
    let second_workspace = store.create_workspace("/second", "second").unwrap();
    let target = store.create_session(&workspace.id, "target").unwrap();
    let other = store.create_session(&workspace.id, "other").unwrap();
    let foreign = store
        .create_session(&second_workspace.id, "foreign")
        .unwrap();
    let task = store
        .create_scheduled_task(
            &workspace.id,
            "heartbeat",
            "prompt",
            &serde_json::json!({"type":"interval","minutes":60}),
            DUE,
            ScheduledTaskMode::Heartbeat,
            Some(&target.id),
            "private task memory",
        )
        .unwrap();
    assert!(store.claim_scheduled_task(&task.id, Some(DUE)).unwrap());
    assert!(matches!(
        store.update_scheduled_task(
            &task.id,
            &task.workspace_id,
            "edited",
            "edited",
            &task.schedule,
            task.mode,
            task.target_session_id.as_deref(),
            "changed",
            NEXT
        ),
        Err(MemoryError::InvalidData(_))
    ));
    for session in [&other, &foreign] {
        assert!(store
            .start_scheduled_task_run(&task.id, &session.id, "must not leak", NEXT)
            .is_err());
        assert!(store.list_messages(&session.id).unwrap().is_empty());
    }
    // Pausing between a scheduled claim and its commit prevents this occurrence.
    store
        .set_scheduled_task_enabled(&task.id, false, None)
        .unwrap();
    assert!(store
        .start_scheduled_task_run(&task.id, &target.id, "must not run", NEXT)
        .is_err());
    assert!(store.list_messages(&target.id).unwrap().is_empty());
    store.release_scheduled_task(&task.id).unwrap();
    assert!(store.claim_scheduled_task(&task.id, None).unwrap());
    store
        .start_scheduled_task_run(&task.id, &target.id, "manual run", NEXT)
        .unwrap();
    assert!(!store.get_scheduled_task(&task.id).unwrap().enabled);
}
