use super::*;
use crate::{CheckpointStore, InterimKind, TurnCheckpoint};

#[derive(Debug, Default)]
struct Segments(Mutex<Vec<(InterimKind, String)>>);

#[async_trait]
impl CheckpointStore for Segments {
    async fn save(&self, _: TurnCheckpoint) -> Result<(), AgentError> {
        Ok(())
    }

    async fn commit_interim(
        &self,
        checkpoint: TurnCheckpoint,
        kind: InterimKind,
    ) -> Result<(), AgentError> {
        self.0.lock().unwrap().push((kind, checkpoint.display_text));
        Ok(())
    }
}

#[tokio::test]
async fn both_completion_gates_mark_proposed_answers_as_continuations() {
    for host_gate in [false, true] {
        let mut first = work("inspect");
        first.insert(0, ChatDelta::Text("Checking the first result".into()));
        let mut turns = vec![first, answer("Everything is ready")];
        if !host_gate {
            turns.push(verdict("continue"));
        }
        turns.extend([
            work("collect"),
            answer("Verified final answer"),
            verdict("finished"),
        ]);
        let provider = MockProvider::new(turns);
        let executor = GatedExecutor {
            work: Executor::default(),
            pending: std::sync::atomic::AtomicUsize::new(usize::from(host_gate)),
        };
        let segments = Arc::new(Segments::default());
        let (events, _) = tokio::sync::mpsc::channel(64);
        let outcome = run_turn_with_limits(
            &provider,
            &executor,
            vec![ChatMessage::user("Inspect and collect every result")],
            events,
            CancellationToken::new(),
            RunLimits {
                checkpoint: Some(segments.clone()),
                ..limits()
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome.final_text, "Verified final answer");
        let saved = segments.0.lock().unwrap();
        assert_eq!(
            saved[0],
            (InterimKind::Commentary, "Checking the first result".into())
        );
        assert_eq!(
            saved[1],
            (InterimKind::Continuation, "Everything is ready".into())
        );
        assert!(saved
            .iter()
            .all(|(_, text)| text != "Verified final answer"));
        assert_eq!(*executor.work.0.lock().unwrap(), ["inspect", "collect"]);
    }
}
