use super::*;
use miniq_memory::Store;
use miniq_models::{
    mock::MockProvider, CompletionRequest, DeltaStream, ModelProvider, ProviderError,
};
use miniq_protocol::SessionGoalUpdate;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

fn fixture(provider: Arc<dyn ModelProvider>) -> (tempfile::TempDir, AppState, String) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let workspace = store
        .create_workspace(directory.path().to_str().unwrap(), "pause")
        .unwrap();
    let session = store.create_session(&workspace.id, "task").unwrap();
    store
        .append_message(&session.id, Role::User, "continue this task")
        .unwrap();
    let state = AppState::new(store, "fixture".into(), provider);
    (directory, state, session.id)
}

fn target(session: &str) -> Option<Value> {
    Some(json!({"sessionId":session}))
}

#[tokio::test]
async fn stopping_a_persisted_pause_prevents_resume_after_runtime_state_is_lost() {
    let provider = Arc::new(MockProvider::text("must not run"));
    let (_directory, state, session) = fixture(provider.clone());
    state
        .store
        .record_turn_outcome(&session, "paused", None)
        .unwrap();
    assert!(!state.is_turn_paused(&session));
    assert!(state.store.session_goal(&session).unwrap().is_none());

    assert_eq!(
        cancel(&state, target(&session)).await.unwrap()["cancelled"],
        true
    );

    assert_eq!(
        state.store.last_turn_outcome(&session).unwrap().unwrap()["status"],
        "cancelled"
    );
    assert_eq!(
        resume(&state, target(&session)).unwrap_err().code,
        ErrorCode::InvalidParams as i64
    );
    assert!(!state.has_active_turn(&session));
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stopping_a_paused_goal_cancels_it_and_prevents_resume() {
    let provider = Arc::new(MockProvider::text("must not run"));
    let (_directory, state, session) = fixture(provider.clone());
    state
        .store
        .update_session_goal(&SessionGoalUpdate {
            session_id: session.clone(),
            goal: "finish the report".into(),
            status: SessionGoalStatus::Paused,
            token_budget: Some(500),
        })
        .unwrap();
    assert!(!state.is_turn_paused(&session));
    assert!(state.store.last_turn_outcome(&session).unwrap().is_none());

    assert_eq!(
        cancel(&state, target(&session)).await.unwrap()["cancelled"],
        true
    );

    let goal = state.store.session_goal(&session).unwrap().unwrap();
    assert_eq!(goal.status, SessionGoalStatus::Cancelled);
    assert_eq!(goal.goal, "finish the report");
    assert_eq!(goal.token_budget, Some(500));
    assert_eq!(
        resume(&state, target(&session)).unwrap_err().code,
        ErrorCode::InvalidParams as i64
    );
    assert!(!state.has_active_turn(&session));
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[derive(Default)]
struct WaitingProvider(AtomicUsize);

#[async_trait::async_trait]
impl ModelProvider for WaitingProvider {
    async fn stream_complete(&self, _: CompletionRequest) -> Result<DeltaStream, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(futures_util::stream::pending()))
    }

    fn describe(&self) -> String {
        "waiting pause fixture".into()
    }
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
async fn repeated_resume_is_rejected_without_resuming_a_later_pause() {
    let provider = Arc::new(WaitingProvider::default());
    let (_directory, state, session) = fixture(provider.clone());
    state
        .store
        .record_turn_outcome(&session, "paused", None)
        .unwrap();

    assert_eq!(resume(&state, target(&session)).unwrap()["resumed"], true);
    wait_until(|| provider.0.load(Ordering::SeqCst) == 1).await;
    assert_eq!(
        resume(&state, target(&session)).unwrap_err().code,
        ErrorCode::InvalidParams as i64
    );
    assert!(!state.take_turn_resume_request(&session));

    assert_eq!(pause(&state, target(&session)).unwrap()["paused"], true);
    wait_until(|| !state.has_active_turn(&session)).await;
    tokio::task::yield_now().await;
    assert!(state.is_turn_paused(&session));
    assert!(!state.has_active_turn(&session));
    assert!(!state.take_turn_resume_request(&session));
    assert_eq!(provider.0.load(Ordering::SeqCst), 1);
    assert_eq!(
        state.store.last_turn_outcome(&session).unwrap().unwrap()["status"],
        "paused"
    );
}

#[tokio::test]
async fn a_new_prompt_replaces_runtime_pause_and_drains_its_followup() {
    let waiting = Arc::new(WaitingProvider::default());
    let (_directory, mut state, session) = fixture(waiting.clone());
    let prompt = |content: &str, reject_if_busy: bool| {
        Some(json!({"sessionId":session,"rejectIfBusy":reject_if_busy,
            "message":{"role":"user","content":content}}))
    };
    send_message(&state, prompt("first task", true))
        .await
        .unwrap();
    wait_until(|| waiting.0.load(Ordering::SeqCst) == 1).await;
    pause(&state, target(&session)).unwrap();
    wait_until(|| !state.has_active_turn(&session)).await;
    assert!(state.is_turn_paused(&session));

    let completing = Arc::new(MockProvider::new(vec![
        vec![miniq_models::ChatDelta::Text("new task done".into())],
        vec![miniq_models::ChatDelta::Text("followup done".into())],
    ]));
    state.provider_override = Some(completing.clone());
    send_message(&state, prompt("replacement task", true))
        .await
        .unwrap();
    assert!(!state.is_turn_paused(&session));
    // This current-thread test queues the follow-up before the spawned turn
    // is polled, so completion must drain it rather than admit another send.
    assert!(send_message(&state, prompt("queued followup", false))
        .await
        .unwrap()["queued"]
        .is_object());

    wait_until(|| {
        completing.requests.lock().unwrap().len() == 2 && !state.has_active_turn(&session)
    })
    .await;
    assert!(!state.is_turn_paused(&session));
    assert!(state
        .store
        .list_queued_messages(&session)
        .unwrap()
        .is_empty());
    let users: Vec<_> = state
        .store
        .list_messages(&session)
        .unwrap()
        .into_iter()
        .filter(|message| message.role == Role::User)
        .map(|message| message.content)
        .collect();
    assert!(users.ends_with(&["replacement task".into(), "queued followup".into()]));
    assert_eq!(
        state.store.last_turn_outcome(&session).unwrap().unwrap()["status"],
        "completed"
    );
}
