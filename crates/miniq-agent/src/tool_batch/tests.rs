use super::*;
use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

#[derive(Debug, Default)]
struct Saved(Mutex<Vec<crate::TurnCheckpoint>>);

#[async_trait]
impl crate::CheckpointStore for Saved {
    async fn save(&self, value: crate::TurnCheckpoint) -> Result<(), AgentError> {
        self.0.lock().unwrap().push(value);
        Ok(())
    }
}

#[derive(Default)]
struct Fixture {
    active: AtomicUsize,
    peak: AtomicUsize,
    version: AtomicUsize,
    started: Mutex<Vec<String>>,
    cancel: CancellationToken,
}

#[async_trait]
impl ToolExecutor for Fixture {
    fn specs(&self) -> Vec<miniq_models::ToolSpec> {
        Vec::new()
    }
    fn execution_mode(&self, call: &ToolCallRequest) -> ToolExecutionMode {
        if call.name == "read" {
            ToolExecutionMode::Parallel
        } else {
            ToolExecutionMode::Sequential
        }
    }
    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        self.started.lock().unwrap().push(call.id.clone());
        let version = self.version.load(Ordering::SeqCst);
        let count = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(count, Ordering::SeqCst);
        if call.name != "read" {
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
    let (state, _, result) = run_batch(&executor, &calls).await;
    result.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(70)); // serial: 100ms
    assert_eq!(executor.peak.load(Ordering::SeqCst), 2);
    assert_eq!(state.appended.len(), calls.len());
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
    let (state, _, result) = run_batch(&executor, &calls).await;
    result.unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(100)); // slots refill before slow read ends
    assert_eq!(executor.peak.load(Ordering::SeqCst), MAX_PARALLEL_CALLS);
    assert_eq!(state.appended.len(), 10);
    for (result, call) in state.appended.iter().zip(calls) {
        assert_eq!(result.tool_call_id.as_deref(), Some(call.id.as_str()));
        assert_eq!(
            serde_json::from_str::<Value>(&result.content).unwrap()["id"],
            call.id
        );
    }
}

#[tokio::test(start_paused = true)]
async fn failure_drains_dispatched_siblings_and_leaves_later_calls_unstarted() {
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
    assert!(result.is_err());
    assert_eq!(executor.started.lock().unwrap().len(), 4);
    assert!(state.history[0].content.contains("unknown"));
    for message in &state.history[1..4] {
        assert!(message.content.contains("version"));
    }
    for message in &state.history[4..] {
        assert!(message.content.contains("not_started"));
    }
    assert_eq!(
        saved.0.lock().unwrap().last().unwrap().history[1].content,
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
