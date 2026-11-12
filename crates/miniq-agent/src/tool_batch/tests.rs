use super::*;
use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

#[derive(Debug, Default)]
struct Saved {
    snapshots: Mutex<Vec<crate::TurnCheckpoint>>,
    reject_at: Option<usize>,
}

#[async_trait]
impl crate::CheckpointStore for Saved {
    async fn save(&self, value: crate::TurnCheckpoint) -> Result<(), AgentError> {
        let mut snapshots = self.snapshots.lock().unwrap();
        snapshots.push(value);
        if self.reject_at == Some(snapshots.len()) {
            Err(AgentError::Checkpoint(
                "interrupted before acknowledgment".into(),
            ))
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct Fixture {
    active: AtomicUsize,
    peak: AtomicUsize,
    version: AtomicUsize,
    started: Mutex<Vec<String>>,
    cancel: CancellationToken,
    saved: Option<Arc<Saved>>,
}

#[async_trait]
impl ToolExecutor for Fixture {
    fn specs(&self) -> Vec<miniq_models::ToolSpec> {
        Vec::new()
    }
    fn execution_mode(&self, call: &ToolCallRequest) -> ToolExecutionMode {
        if matches!(call.name.as_str(), "read" | "shell_run" | "web_search") {
            ToolExecutionMode::Parallel
        } else {
            ToolExecutionMode::Sequential
        }
    }
    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        if let Some(saved) = &self.saved {
            let snapshots = saved.snapshots.lock().unwrap();
            let result = snapshots
                .last()
                .unwrap()
                .history
                .iter()
                .find(|message| message.tool_call_id.as_deref() == Some(call.id.as_str()))
                .expect("every dispatch must already have a durable tool result pair");
            assert!(result.content.contains("unknown"));
        }
        self.started.lock().unwrap().push(call.id.clone());
        let version = self.version.load(Ordering::SeqCst);
        let count = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(count, Ordering::SeqCst);
        if self.execution_mode(call) == ToolExecutionMode::Sequential {
            assert_eq!(count, 1, "serial operation overlapped another call");
            self.version.fetch_add(1, Ordering::SeqCst);
        }
        tokio::time::sleep(Duration::from_millis(
            call.arguments["ms"].as_u64().unwrap(),
        ))
        .await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        if call.id == "fail" {
            return Err(AgentError::Checkpoint("fixture failure".into()));
        }
        if call.id == "cancel" {
            self.cancel.cancel();
        }
        Ok(json!({"id":call.id,"version":version}))
    }
}

fn call(id: &str, name: &str, ms: u64) -> ToolCallRequest {
    ToolCallRequest {
        id: id.into(),
        name: name.into(),
        arguments: json!({"ms":ms}),
    }
}

async fn run_batch(
    executor: &Fixture,
    calls: &[ToolCallRequest],
) -> (RunState, Arc<Saved>, Result<(), AgentError>) {
    let mut state = RunState::new(Vec::new());
    let saved = Arc::new(Saved::default());
    let limits = RunLimits {
        checkpoint: Some(saved.clone()),
        ..RunLimits::default()
    };
    let result = execute(executor, calls, &mut state, &limits, &executor.cancel).await;
    (state, saved, result)
}

#[tokio::test(start_paused = true)]
async fn independent_shell_and_web_calls_overlap() {
    let executor = Fixture::default();
    let calls = [
        call("shell", "shell_run", 30),
        call("web", "web_search", 50),
    ];
    let start = tokio::time::Instant::now();
    let (state, saved, result) = run_batch(&executor, &calls).await;
    result.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(50));
    assert_eq!(executor.peak.load(Ordering::SeqCst), 2);
    assert_eq!(state.appended.len(), 2);
    assert_eq!(state.appended[0].tool_call_id.as_deref(), Some("shell"));
    assert_eq!(state.appended[1].tool_call_id.as_deref(), Some("web"));
    assert_eq!(saved.snapshots.lock().unwrap().len(), calls.len() + 1);
}

#[tokio::test(start_paused = true)]
async fn mixed_batch_overlaps_reads_without_crossing_serial_barriers() {
    let executor = Fixture::default();
    let calls = [
        call("a", "read", 30),
        call("b", "read", 10),
        call("write", "write", 10),
        call("c", "read", 20),
        call("d", "read", 30),
    ];
    let start = tokio::time::Instant::now();
    let (state, saved, result) = run_batch(&executor, &calls).await;
    result.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(70)); // serial: 100ms
    assert_eq!(executor.peak.load(Ordering::SeqCst), 2);
    assert_eq!(state.appended.len(), calls.len());
    assert_eq!(saved.snapshots.lock().unwrap().len(), 7);
    for (index, (message, call)) in state.history.iter().zip(&calls).enumerate() {
        assert_eq!(message.tool_call_id.as_deref(), Some(call.id.as_str()));
        let value: Value = serde_json::from_str(&message.content).unwrap();
        assert_eq!(value["id"], call.id);
        assert_eq!(value["version"], if index < 3 { 0 } else { 1 });
    }
}

#[tokio::test(start_paused = true)]
async fn bounded_parallelism_refills_slots_and_keeps_every_result_in_input_order() {
    let executor = Fixture::default();
    let calls = (0..10)
        .map(|i| call(&i.to_string(), "read", if i == 0 { 100 } else { 10 }))
        .collect::<Vec<_>>();
    let start = tokio::time::Instant::now();
    let (state, saved, result) = run_batch(&executor, &calls).await;
    result.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(100)); // slots refill before slow read ends
    assert_eq!(executor.peak.load(Ordering::SeqCst), MAX_PARALLEL_CALLS);
    assert_eq!(state.appended.len(), 10);
    assert_eq!(saved.snapshots.lock().unwrap().len(), calls.len() + 1);
    for (result, call) in state.appended.iter().zip(calls) {
        assert_eq!(result.tool_call_id.as_deref(), Some(call.id.as_str()));
        assert_eq!(
            serde_json::from_str::<Value>(&result.content).unwrap()["id"],
            call.id
        );
    }
}

#[tokio::test(start_paused = true)]
async fn sequential_admission_also_commits_the_previous_result() {
    let executor = Fixture::default();
    let calls = [
        call("a", "write", 5),
        call("b", "write", 5),
        call("c", "write", 5),
    ];
    let (_, saved, result) = run_batch(&executor, &calls).await;
    result.unwrap();
    let snapshots = saved.snapshots.lock().unwrap();
    assert_eq!(snapshots.len(), calls.len() + 1);
    for (index, snapshot) in snapshots.iter().take(calls.len()).enumerate() {
        for result in &snapshot.history[..index] {
            assert!(result.content.contains("version"));
        }
        assert!(snapshot.history[index].content.contains("unknown"));
        for result in &snapshot.history[index + 1..] {
            assert!(result.content.contains("not_started"));
        }
    }
}

#[tokio::test(start_paused = true)]
async fn failure_becomes_a_tool_result_and_later_calls_continue() {
    let executor = Fixture::default();
    let calls = [
        call("fail", "read", 5),
        call("b", "read", 20),
        call("c", "read", 10),
        call("d", "read", 15),
        call("e", "read", 10),
        call("write", "write", 10),
    ];
    let (state, saved, result) = run_batch(&executor, &calls).await;
    result.unwrap();
    assert_eq!(executor.started.lock().unwrap().len(), calls.len());
    assert!(state.history[0].content.contains("execution\":\"failed"));
    assert!(state.history[0].content.contains("fixture failure"));
    for message in &state.history[1..] {
        assert!(message.content.contains("version"));
    }
    assert_eq!(
        saved.snapshots.lock().unwrap().last().unwrap().history[1].content,
        state.history[1].content
    );
}

#[tokio::test(start_paused = true)]
async fn cancellation_preserves_successes_without_starting_queued_calls_or_the_barrier() {
    let executor = Fixture::default();
    let calls = [
        call("cancel", "read", 5),
        call("b", "read", 20),
        call("c", "read", 10),
        call("d", "read", 15),
        call("e", "read", 10),
        call("write", "write", 10),
    ];
    let (state, _, result) = run_batch(&executor, &calls).await;
    assert!(matches!(result, Err(AgentError::Cancelled)));
    assert_eq!(executor.started.lock().unwrap().len(), 4);
    for message in &state.history[..4] {
        assert!(message.content.contains("version"));
    }
    for message in &state.history[4..] {
        assert!(message.content.contains("not_started"));
    }
    assert_eq!(executor.active.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn parallel_admission_is_durable_before_any_member_or_refill_runs() {
    let saved = Arc::new(Saved::default());
    let executor = Fixture {
        saved: Some(saved.clone()),
        ..Default::default()
    };
    let calls = (0..7)
        .map(|index| call(&index.to_string(), "read", 5))
        .collect::<Vec<_>>();
    let mut state = RunState::new(Vec::new());
    execute(
        &executor,
        &calls,
        &mut state,
        &RunLimits {
            checkpoint: Some(saved.clone()),
            ..Default::default()
        },
        &executor.cancel,
    )
    .await
    .unwrap();
    let snapshots = saved.snapshots.lock().unwrap();
    assert_eq!(snapshots.len(), calls.len() + 1);
    assert!(snapshots[0].history[..MAX_PARALLEL_CALLS]
        .iter()
        .all(|message| message.content.contains("unknown")));
    assert!(snapshots[0].history[MAX_PARALLEL_CALLS..]
        .iter()
        .all(|message| message.content.contains("not_started")));
    assert_eq!(executor.started.lock().unwrap().len(), calls.len());
}

#[tokio::test(start_paused = true)]
async fn failed_parallel_admission_does_not_dispatch_any_side_effect() {
    let saved = Arc::new(Saved {
        reject_at: Some(1),
        ..Default::default()
    });
    let executor = Fixture {
        saved: Some(saved.clone()),
        ..Default::default()
    };
    let calls = (0..7)
        .map(|index| call(&index.to_string(), "read", 5))
        .collect::<Vec<_>>();
    let result = execute(
        &executor,
        &calls,
        &mut RunState::new(Vec::new()),
        &RunLimits {
            checkpoint: Some(saved.clone()),
            ..Default::default()
        },
        &executor.cancel,
    )
    .await;
    assert!(matches!(result, Err(AgentError::Checkpoint(_))));
    assert!(executor.started.lock().unwrap().is_empty());
    assert_eq!(saved.snapshots.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn interrupted_admission_restores_confirmed_results_without_replaying_old_calls() {
    let saved = Arc::new(Saved {
        reject_at: Some(2),
        ..Default::default()
    });
    let executor = Fixture {
        saved: Some(saved.clone()),
        ..Default::default()
    };
    let calls = [
        call("first", "write", 5),
        call("second", "write", 5),
        call("third", "write", 5),
    ];
    let mut assistant = ChatMessage::assistant("working");
    assistant.tool_calls = calls.to_vec();
    let mut state = RunState::new(vec![ChatMessage::user("old task"), assistant]);
    let result = execute(
        &executor,
        &calls,
        &mut state,
        &RunLimits {
            checkpoint: Some(saved.clone()),
            ..Default::default()
        },
        &executor.cancel,
    )
    .await;
    assert!(matches!(result, Err(AgentError::Checkpoint(_))));
    let mut restored = saved
        .snapshots
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .history
        .clone();
    assert!(restored[2].content.contains("version"));
    assert!(restored[3].content.contains("unknown"));
    assert!(restored[4].content.contains("not_started"));
    restored.push(ChatMessage::user("new request; do not resume the old task"));
    let (events, _receiver) = tokio::sync::mpsc::channel(16);
    let provider = miniq_models::mock::MockProvider::text("answer to the new request");
    let outcome = crate::run_turn_with_limits(
        &provider,
        &executor,
        restored,
        events,
        CancellationToken::new(),
        RunLimits::default(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.final_text, "answer to the new request");
    assert_eq!(*executor.started.lock().unwrap(), ["first"]);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].messages.last().unwrap().content,
        "new request; do not resume the old task"
    );
    assert!(requests[0]
        .messages
        .iter()
        .any(|message| message.tool_call_id.as_deref() == Some("first")
            && message.content.contains("version")));
}
