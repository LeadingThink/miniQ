use super::*;
use miniq_protocol::HistoryParams;
use serde_json::json;

fn session(store: &Store, label: &str) -> String {
    let workspace = store
        .create_workspace(&format!("/tmp/turn-timing-{label}"), label)
        .unwrap();
    store.create_session(&workspace.id, label).unwrap().id
}

fn complete(store: &Store, session: &str, status: TurnTimingStatus) -> MessageTurnTiming {
    let (message_id, mut timing) = store.start_turn_timing(session).unwrap();
    timing.status = status;
    timing.completed_at = Some(now_iso());
    timing.elapsed_ms = Some(1_234);
    store
        .finish_turn_timing(session, &message_id, &timing)
        .unwrap();
    MessageTurnTiming { message_id, timing }
}

#[test]
fn timing_survives_reopen_and_is_attached_only_to_its_user_message() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("timing.sqlite");
    let store = Store::open(&path).unwrap();
    let session = session(&store, "persisted");
    let user = store.append_message(&session, Role::User, "task").unwrap();
    let measured = complete(&store, &session, TurnTimingStatus::Completed);
    store
        .append_message(&session, Role::Assistant, "answer")
        .unwrap();
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.latest_turn_timing(&session).unwrap(),
        Some(measured.clone())
    );
    let messages = reopened.list_messages(&session).unwrap();
    assert_eq!(messages[0].id, user.id);
    assert_eq!(messages[0].turn_timing, Some(measured.timing.clone()));
    assert!(messages[1].turn_timing.is_none());
    let mut query: HistoryParams =
        serde_json::from_value(json!({"sessionId":session,"limit":1})).unwrap();
    let newest = reopened.history_page(&query).unwrap();
    assert!(newest.messages[0].turn_timing.is_none());
    query.before = newest.next_cursor;
    let older = reopened.history_page(&query).unwrap();
    assert_eq!(older.messages[0].turn_timing, Some(measured.timing));
    let search = reopened.search_messages("task", 10).unwrap();
    assert_eq!(
        search[0].turn_timing.as_ref().unwrap().elapsed_ms,
        Some(1_234)
    );
}

#[test]
fn old_history_and_next_queued_request_do_not_inherit_previous_timing() {
    let store = Store::open_in_memory().unwrap();
    let session = session(&store, "queue");
    store.append_message(&session, Role::User, "first").unwrap();
    assert!(store.latest_turn_timing(&session).unwrap().is_none());
    let first = complete(&store, &session, TurnTimingStatus::Failed);
    store
        .enqueue_message_with_attachments(&session, "queued", &[])
        .unwrap();
    assert_eq!(store.latest_turn_timing(&session).unwrap(), Some(first));
    let next = store.start_queued_message(&session).unwrap().unwrap();
    assert!(next.turn_timing.is_none());
    assert!(store.latest_turn_timing(&session).unwrap().is_none());
    let (id, timing) = store.start_turn_timing(&session).unwrap();
    assert_eq!(id, next.id);
    assert_eq!(timing.status, TurnTimingStatus::Running);
    assert!(timing.elapsed_ms.is_none());
}

#[test]
fn rewriting_discards_old_timings_and_starts_an_independent_execution() {
    let store = Store::open_in_memory().unwrap();
    let session = session(&store, "rewrite");
    let first = store
        .append_message(&session, Role::User, "original")
        .unwrap();
    complete(&store, &session, TurnTimingStatus::Completed);
    store
        .append_message(&session, Role::Assistant, "answer")
        .unwrap();
    store.append_message(&session, Role::User, "later").unwrap();
    complete(&store, &session, TurnTimingStatus::Cancelled);
    let rewrite = store
        .rewrite_session_from_user_message(&session, &first.id, "changed", &[])
        .unwrap();
    assert!(rewrite.message.turn_timing.is_none());
    assert!(store.latest_turn_timing(&session).unwrap().is_none());
    assert_eq!(
        store
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM audit_events WHERE event_type = 'turn_timing'",
                [],
                |row| row.get::<_, u64>(0),
            )
            .unwrap(),
        0
    );
    let (id, timing) = store.start_turn_timing(&session).unwrap();
    assert_eq!(id, first.id);
    assert!(timing.elapsed_ms.is_none());
    assert_eq!(timing.status, TurnTimingStatus::Running);
}

#[test]
fn recovery_stops_only_running_clocks_without_counting_time_offline() {
    let store = Store::open_in_memory().unwrap();
    let first = session(&store, "active");
    let second = session(&store, "another");
    let finished = session(&store, "finished");
    for id in [&first, &second, &finished] {
        store.append_message(id, Role::User, "task").unwrap();
    }
    store.start_turn_timing(&first).unwrap();
    store.start_turn_timing(&second).unwrap();
    let completed = complete(&store, &finished, TurnTimingStatus::Completed);
    store.recover_interrupted_session(&first).unwrap();
    let recovered = store.latest_turn_timing(&first).unwrap().unwrap().timing;
    assert_eq!(recovered.status, TurnTimingStatus::Interrupted);
    assert!(recovered.completed_at.is_none());
    assert!(recovered.elapsed_ms.is_none());
    assert_eq!(
        store
            .latest_turn_timing(&second)
            .unwrap()
            .unwrap()
            .timing
            .status,
        TurnTimingStatus::Running
    );
    store.recover_interrupted_work().unwrap();
    let second = store.latest_turn_timing(&second).unwrap().unwrap().timing;
    assert_eq!(second.status, TurnTimingStatus::Interrupted);
    assert!(second.completed_at.is_none());
    assert!(second.elapsed_ms.is_none());
    assert_eq!(
        store.latest_turn_timing(&finished).unwrap(),
        Some(completed)
    );
}

#[test]
fn terminal_updates_cannot_overwrite_other_sessions_or_completed_runs() {
    let store = Store::open_in_memory().unwrap();
    let first = session(&store, "one");
    let second = session(&store, "two");
    store.append_message(&first, Role::User, "task").unwrap();
    let (message, mut timing) = store.start_turn_timing(&first).unwrap();
    timing.status = TurnTimingStatus::Cancelled;
    timing.elapsed_ms = Some(50);
    timing.completed_at = Some(now_iso());
    assert!(store
        .finish_turn_timing(&second, &message, &timing)
        .is_err());
    store.finish_turn_timing(&first, &message, &timing).unwrap();
    timing.status = TurnTimingStatus::Completed;
    assert!(store.finish_turn_timing(&first, &message, &timing).is_err());
    assert_eq!(
        store
            .latest_turn_timing(&first)
            .unwrap()
            .unwrap()
            .timing
            .status,
        TurnTimingStatus::Cancelled
    );
}
