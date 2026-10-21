use super::*;
use miniq_memory::Store;
use miniq_models::{
    mock::MockProvider, ChatDelta, CompletionRequest, DeltaStream, ModelProvider, ProviderError,
};
use std::path::Path;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

fn fixture(directory: &Path, provider: Arc<dyn ModelProvider>) -> (AppState, String) {
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.to_str().unwrap(), "admission")
        .unwrap();
    let session = store.create_session(&workspace.id, "task").unwrap();
    (AppState::new(store, "fixture".into(), provider), session.id)
}

fn input(session: &str) -> Option<Value> {
    Some(
        json!({"sessionId":session,"rejectIfBusy":true,"message":{"role":"user","content":"new task"}}),
    )
}

fn hook(state: &AppState, command: &str) {
    state.settings.lock().unwrap().hooks = vec![crate::hooks::HookConfig {
        event: "userPromptSubmit".into(),
        matcher: None,
        command: command.into(),
        timeout_secs: Some(30),
        enabled: None,
    }];
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn busy_guard_rejects_before_a_submit_hook_can_run() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::text("unused"));
    let (state, session) = fixture(directory.path(), provider.clone());
    hook(&state, "exit 2");
    let token = state.begin_turn(&session).unwrap();
    let error = send_message(&state, input(&session)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::SessionBusy as i64);
    assert_eq!(state.store.count_audit_events(&session).unwrap(), 0);
    assert!(state.store.list_messages(&session).unwrap().is_empty());
    assert!(provider.requests.lock().unwrap().is_empty());
    assert!(!token.is_cancelled());
    state.end_turn(&session);
}

#[tokio::test]
async fn busy_queue_rejects_a_step_limit_it_cannot_preserve() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::text("must not run"));
    let (state, session) = fixture(directory.path(), provider.clone());
    let token = state.begin_turn(&session).unwrap();
    let mut params = input(&session).unwrap();
    params["rejectIfBusy"] = json!(false);
    params["maxTurns"] = json!(3);
    let error = send_message(&state, Some(params)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidParams as i64);
    assert!(error.message.contains("maxTurns"));
    assert!(state
        .store
        .list_queued_messages(&session)
        .unwrap()
        .is_empty());
    assert!(state.store.list_messages(&session).unwrap().is_empty());
    assert!(state.has_active_turn(&session));
    assert!(!token.is_cancelled());
    assert!(provider.requests.lock().unwrap().is_empty());
    state.end_turn(&session);
}

#[tokio::test]
async fn hook_rejection_releases_admission_and_keeps_the_prompt_unsent() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session) = fixture(directory.path(), Arc::new(MockProvider::text("unused")));
    hook(&state, "exit 2");
    let error = send_message(&state, input(&session)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidParams as i64);
    assert_eq!(state.store.count_audit_events(&session).unwrap(), 1);
    assert!(!state.has_active_turn(&session));
    assert!(state.store.list_messages(&session).unwrap().is_empty());
    assert!(state.begin_turn(&session).is_some());
    state.end_turn(&session);
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_a_submit_hook_stops_its_children_without_starting_a_task() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::text("unused"));
    let (state, session) = fixture(directory.path(), provider.clone());
    hook(
        &state,
        "touch hook-started; (sleep 0.4; touch child-finished) & wait",
    );
    let sending = {
        let state = state.clone();
        let session = session.clone();
        tokio::spawn(async move { send_message(&state, input(&session)).await })
    };
    wait_until(|| directory.path().join("hook-started").exists()).await;
    let stopped = cancel(&state, Some(json!({"sessionId":session})))
        .await
        .unwrap();
    assert_eq!(stopped["cancelled"], true);
    assert_eq!(
        sending.await.unwrap().unwrap_err().code,
        ErrorCode::Cancelled as i64
    );
    assert!(!state.has_active_turn(&session));
    assert_eq!(
        state.store.get_session(&session).unwrap().status,
        SessionStatus::Idle
    );
    assert!(state.store.list_messages(&session).unwrap().is_empty());
    assert!(provider.requests.lock().unwrap().is_empty());
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(!directory.path().join("child-finished").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_a_pending_request_releases_its_unstarted_turn() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session) = fixture(directory.path(), Arc::new(MockProvider::text("unused")));
    hook(&state, "touch hook-started; sleep 30");
    let sending = {
        let state = state.clone();
        let session = session.clone();
        tokio::spawn(async move { send_message(&state, input(&session)).await })
    };
    wait_until(|| directory.path().join("hook-started").exists()).await;
    assert!(state.has_active_turn(&session));
    sending.abort();
    assert!(sending.await.unwrap_err().is_cancelled());
    assert!(!state.has_active_turn(&session));
    assert!(state.store.list_messages(&session).unwrap().is_empty());
}

struct FirstTurnWaits(AtomicUsize);

#[async_trait::async_trait]
impl ModelProvider for FirstTurnWaits {
    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(Box::pin(futures_util::stream::pending()))
        } else {
            Ok(Box::pin(futures_util::stream::iter(vec![
                Ok(ChatDelta::Text("done".into())),
                Ok(ChatDelta::Finished),
            ])))
        }
    }
    fn describe(&self) -> String {
        "first turn waits".into()
    }
}

#[tokio::test]
async fn cancellation_response_precedes_no_old_terminal_events_or_active_slot() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(FirstTurnWaits(AtomicUsize::new(0)));
    let (state, session) = fixture(directory.path(), provider.clone());
    send_message(&state, input(&session)).await.unwrap();
    wait_until(|| provider.0.load(Ordering::SeqCst) == 1).await;
    cancel(&state, Some(json!({"sessionId":session})))
        .await
        .unwrap();
    assert!(!state.has_active_turn(&session));
    assert_eq!(
        state.store.last_turn_outcome(&session).unwrap().unwrap()["status"],
        "cancelled"
    );
    let mut events = state.events.subscribe();
    send_message(&state, input(&session)).await.unwrap();
    wait_until(|| !state.has_active_turn(&session)).await;
    let mut completed = 0;
    while let Ok(event) = events.try_recv() {
        match event {
            Event::TurnFailed { error, .. } => {
                panic!("previous turn leaked after cancellation response: {error}")
            }
            Event::TurnCompleted { .. } => completed += 1,
            _ => {}
        }
    }
    assert_eq!(completed, 1);
    assert_eq!(provider.0.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn stopping_timeout_keeps_the_active_slot_until_its_owner_finishes() {
    let directory = tempfile::tempdir().unwrap();
    let (state, session) = fixture(directory.path(), Arc::new(MockProvider::text("unused")));
    let token = state.begin_turn(&session).unwrap();
    let error = cancel(&state, Some(json!({"sessionId":session})))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::SessionBusy as i64);
    assert!(token.is_cancelled());
    assert!(state.has_active_turn(&session));
    assert!(state.begin_turn(&session).is_none());
    state.end_turn(&session);
}

#[tokio::test]
async fn ordinary_paused_turn_resumes_after_runtime_pause_state_is_lost() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(FirstTurnWaits(AtomicUsize::new(0)));
    let (state, session) = fixture(directory.path(), provider.clone());
    send_message(&state, input(&session)).await.unwrap();
    wait_until(|| provider.0.load(Ordering::SeqCst) == 1).await;
    pause(&state, Some(json!({"sessionId":session}))).unwrap();
    wait_until(|| !state.has_active_turn(&session)).await;
    assert!(state.store.session_goal(&session).unwrap().is_none());
    assert_eq!(
        state.store.last_turn_outcome(&session).unwrap().unwrap()["status"],
        "paused"
    );
    state.clear_paused_turn(&session);
    assert_eq!(
        resume(&state, Some(json!({"sessionId":session}))).unwrap()["resumed"],
        true
    );
    wait_until(|| !state.has_active_turn(&session)).await;
    assert_eq!(provider.0.load(Ordering::SeqCst), 2);
    assert_eq!(
        state.store.last_turn_outcome(&session).unwrap().unwrap()["status"],
        "completed"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn stop_invalidates_a_queued_prompt_still_running_its_submit_hook() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(FirstTurnWaits(AtomicUsize::new(0)));
    let (state, session) = fixture(directory.path(), provider.clone());
    send_message(&state, input(&session)).await.unwrap();
    wait_until(|| provider.0.load(Ordering::SeqCst) == 1).await;
    hook(&state, "touch queued-hook; sleep 30");
    let queued = {
        let state = state.clone();
        let session = session.clone();
        tokio::spawn(async move {
            let mut params = input(&session).unwrap();
            params["rejectIfBusy"] = json!(false);
            params["message"]["content"] = json!("queued prompt");
            send_message(&state, Some(params)).await
        })
    };
    wait_until(|| directory.path().join("queued-hook").exists()).await;
    cancel(&state, Some(json!({"sessionId":session})))
        .await
        .unwrap();
    assert_eq!(
        queued.await.unwrap().unwrap_err().code,
        ErrorCode::Cancelled as i64
    );
    assert!(!state.has_active_turn(&session));
    assert!(state
        .store
        .list_queued_messages(&session)
        .unwrap()
        .is_empty());
    assert_eq!(
        state
            .store
            .list_messages(&session)
            .unwrap()
            .iter()
            .filter(|message| message.role == Role::User)
            .count(),
        1
    );
    assert_eq!(provider.0.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
async fn queue_during_preparation(
    state: &AppState,
    session: &str,
    directory: &Path,
) -> tokio::task::JoinHandle<Result<Value, RpcError>> {
    hook(state, "payload=$(cat); case \"$payload\" in *'\"prompt\":\"first\"'*) touch first-hook; while [ ! -f release-first ]; do sleep 0.01; done; exit 2;; *) exit 0;; esac");
    let preparing = {
        let state = state.clone();
        let session = session.to_owned();
        tokio::spawn(async move {
            let mut params = input(&session).unwrap();
            params["message"]["content"] = json!("first");
            send_message(&state, Some(params)).await
        })
    };
    wait_until(|| directory.join("first-hook").exists()).await;
    let mut params = input(session).unwrap();
    params["rejectIfBusy"] = json!(false);
    params["message"]["content"] = json!("second");
    assert!(send_message(state, Some(params)).await.unwrap()["queued"].is_object());
    preparing
}

#[cfg(unix)]
#[tokio::test]
async fn rejected_or_dropped_preparation_wakes_accepted_queued_messages() {
    for drop_request in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let provider = Arc::new(MockProvider::text("queued answer"));
        let (state, session) = fixture(directory.path(), provider.clone());
        let preparing = queue_during_preparation(&state, &session, directory.path()).await;
        if drop_request {
            preparing.abort();
            assert!(preparing.await.unwrap_err().is_cancelled());
        } else {
            std::fs::write(directory.path().join("release-first"), "ready").unwrap();
            assert_eq!(
                preparing.await.unwrap().unwrap_err().code,
                ErrorCode::InvalidParams as i64
            );
        }
        wait_until(|| !state.has_active_turn(&session)).await;
        assert!(state
            .store
            .list_queued_messages(&session)
            .unwrap()
            .is_empty());
        let messages = state.store.list_messages(&session).unwrap();
        let users: Vec<_> = messages
            .iter()
            .filter(|message| message.role == Role::User)
            .collect();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].content, "second");
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_keeps_the_queue_without_admitting_a_drain_after_preparation_stops() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::text("must not run"));
    let (state, session) = fixture(directory.path(), provider.clone());
    let preparing = queue_during_preparation(&state, &session, directory.path()).await;
    state.activity.close();
    state.cancel_all_turns();
    assert_eq!(
        preparing.await.unwrap().unwrap_err().code,
        ErrorCode::Cancelled as i64
    );
    assert!(!state.has_active_turn(&session));
    assert_eq!(state.store.list_queued_messages(&session).unwrap().len(), 1);
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn preparation_cannot_pause_and_resume_an_unaccepted_prompt() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::text("must not run while paused"));
    let (state, session) = fixture(directory.path(), provider.clone());
    let preparing = queue_during_preparation(&state, &session, directory.path()).await;
    assert_eq!(
        pause(&state, Some(json!({"sessionId":session})))
            .unwrap_err()
            .code,
        ErrorCode::InvalidParams as i64
    );
    assert_eq!(
        resume(&state, Some(json!({"sessionId":session})))
            .unwrap_err()
            .code,
        ErrorCode::InvalidParams as i64
    );
    assert!(state.has_active_turn(&session));
    assert!(!state.is_turn_paused(&session));
    assert_eq!(state.store.list_queued_messages(&session).unwrap().len(), 1);
    assert!(provider.requests.lock().unwrap().is_empty());
    cancel(&state, Some(json!({"sessionId":session})))
        .await
        .unwrap();
    assert_eq!(
        preparing.await.unwrap().unwrap_err().code,
        ErrorCode::Cancelled as i64
    );
    assert!(!state.is_turn_paused(&session));
    assert!(state
        .store
        .list_queued_messages(&session)
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_turn_ends_and_enqueue_commits_do_not_strand_or_duplicate_prompts() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::new(
        (0..50)
            .map(|_| vec![ChatDelta::Text("done".into())])
            .collect(),
    ));
    let (state, session) = fixture(directory.path(), provider.clone());
    let mut sending = Vec::new();
    for index in 0..50 {
        let state = state.clone();
        let session = session.clone();
        sending.push(tokio::spawn(async move {
            let mut params = input(&session).unwrap();
            params["rejectIfBusy"] = json!(false);
            params["message"]["content"] = json!(format!("prompt {index}"));
            send_message(&state, Some(params)).await.unwrap();
        }));
    }
    for task in sending {
        task.await.unwrap();
    }
    wait_until(|| {
        !state.has_active_turn(&session)
            && state
                .store
                .list_queued_messages(&session)
                .unwrap()
                .is_empty()
    })
    .await;
    let messages = state.store.list_messages(&session).unwrap();
    let mut prompts: Vec<_> = messages
        .iter()
        .filter(|message| message.role == Role::User)
        .map(|message| message.content.as_str())
        .collect();
    prompts.sort_unstable();
    prompts.dedup();
    assert_eq!(prompts.len(), 50);
    assert_eq!(provider.requests.lock().unwrap().len(), 50);
}

#[cfg(unix)]
#[tokio::test]
async fn idle_update_protects_lifecycle_and_legacy_completion_hooks_from_spawn_to_exit() {
    for event in ["sessionStart", "stop", "legacy"] {
        let directory = tempfile::tempdir().unwrap();
        let (state, session) = fixture(directory.path(), Arc::new(MockProvider::text("unused")));
        let directory_arg = directory.path().to_string_lossy().replace('\'', "'\\''");
        let command = format!("cd '{directory_arg}' && touch hook-started; while [ ! -f release-hook ]; do sleep 0.01; done; touch hook-finished");
        if event == "legacy" {
            state.settings.lock().unwrap().turn_ended_command = Some(command.clone());
            state.run_turn_ended_hook(&session, "completed");
        } else {
            hook(&state, &command);
            state.settings.lock().unwrap().hooks[0].event = event.into();
            crate::hooks::spawn_event(
                &state,
                &session,
                if event == "stop" {
                    crate::hooks::HookEvent::Stop
                } else {
                    crate::hooks::HookEvent::SessionStart
                },
                crate::hooks::HookPayload::default(),
            );
        }
        assert!(
            state.activity.close_if_idle(|| Ok(())).is_err(),
            "{event} must reserve activity before spawning"
        );
        wait_until(|| directory.path().join("hook-started").exists()).await;
        std::fs::write(directory.path().join("release-hook"), "ready").unwrap();
        wait_until(|| state.activity.close_if_idle(|| Ok(())).is_ok()).await;
        assert!(
            directory.path().join("hook-finished").exists(),
            "{event} was interrupted"
        );
    }
}
