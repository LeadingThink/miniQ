//! Detects a model that keeps issuing the same tool batch without progress.
//!
//! Identical call arguments alone are not a loop: polling a CI run or a
//! background process legitimately repeats the same call while the observed
//! state changes. A round only counts as a repetition when both the calls and
//! their (normalized) results match the previous round. When the limit is
//! reached the next identical batch is not executed; the model first receives
//! a corrective tool result, and only an immediate repeat ends the turn.

use miniq_models::{ChatMessage, ToolCallRequest};
use serde_json::{json, Value};

/// Result fields that change on every execution without carrying progress.
const VOLATILE_RESULT_KEYS: &[&str] = &[
    "durationMs",
    "elapsedMs",
    "observationId",
    "timestamp",
    "startedAt",
    "updatedAt",
    "completedAt",
    "observedAt",
];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Execute,
    /// Skip execution and return a corrective result to the model.
    Warn {
        repetitions: usize,
    },
    /// The model ignored the warning and repeated the batch again.
    Stop {
        repetitions: usize,
    },
}

#[derive(Default)]
pub(crate) struct LoopGuard {
    calls: String,
    results: String,
    identical_rounds: usize,
    warned: bool,
}

impl LoopGuard {
    pub(crate) fn check(&mut self, calls: &str, limit: usize) -> Verdict {
        let limit = limit.max(1);
        if calls != self.calls || self.identical_rounds + 1 < limit {
            return Verdict::Execute;
        }
        let repetitions = self.identical_rounds + 1;
        if self.warned {
            Verdict::Stop { repetitions }
        } else {
            self.warned = true;
            Verdict::Warn { repetitions }
        }
    }

    pub(crate) fn record(&mut self, calls: String, results: String) {
        if calls == self.calls && results == self.results {
            self.identical_rounds += 1;
        } else {
            self.identical_rounds = 1;
            self.warned = false;
        }
        self.calls = calls;
        self.results = results;
    }
}

fn strip_volatile(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in VOLATILE_RESULT_KEYS {
                map.remove(*key);
            }
            map.values_mut().for_each(strip_volatile);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_volatile),
        _ => {}
    }
}

pub(crate) fn result_fingerprint(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .map(
            |message| match serde_json::from_str::<Value>(&message.content) {
                Ok(mut value) => {
                    strip_volatile(&mut value);
                    value.to_string()
                }
                Err(_) => message.content.clone(),
            },
        )
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn warning_result(call: &ToolCallRequest, repetitions: usize) -> ChatMessage {
    ChatMessage::tool_result(
        call.id.clone(),
        json!({
            "executed": false,
            "repeatedToolLoop": true,
            "repetitions": repetitions,
            "message": format!(
                "Not executed: this exact tool batch already ran {} times in a row with identical results. \
                 Repeating it unchanged will end the turn. Change approach: when waiting for a long task, \
                 use process_output with block=true and a larger timeoutSecs (up to 600) or a longer sleep; \
                 otherwise inspect the actual state, try a different action, or report what is blocking.",
                repetitions - 1
            ),
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(content: Value) -> ChatMessage {
        ChatMessage::tool_result("call", content.to_string())
    }

    #[test]
    fn identical_calls_with_changing_results_keep_executing() {
        let mut guard = LoopGuard::default();
        for round in 0..20 {
            assert_eq!(guard.check("poll", 4), Verdict::Execute);
            guard.record("poll".into(), format!("status {round}"));
        }
    }

    #[test]
    fn identical_calls_and_results_warn_then_stop() {
        let mut guard = LoopGuard::default();
        for _ in 0..3 {
            assert_eq!(guard.check("poll", 4), Verdict::Execute);
            guard.record("poll".into(), "running".into());
        }
        assert_eq!(guard.check("poll", 4), Verdict::Warn { repetitions: 4 });
        assert_eq!(guard.check("poll", 4), Verdict::Stop { repetitions: 4 });
    }

    #[test]
    fn changing_approach_after_a_warning_resets_the_guard() {
        let mut guard = LoopGuard::default();
        for _ in 0..3 {
            guard.record("poll".into(), "running".into());
        }
        assert!(matches!(guard.check("poll", 4), Verdict::Warn { .. }));
        assert_eq!(guard.check("wait longer", 4), Verdict::Execute);
        guard.record("wait longer".into(), "running".into());
        for _ in 0..2 {
            assert_eq!(guard.check("poll", 4), Verdict::Execute);
            guard.record("poll".into(), "running".into());
        }
        assert_eq!(guard.check("poll", 4), Verdict::Execute);
        guard.record("poll".into(), "running".into());
        assert_eq!(guard.check("poll", 4), Verdict::Warn { repetitions: 4 });
    }

    #[test]
    fn volatile_timing_fields_do_not_hide_a_loop() {
        let first = result_fingerprint(&[tool(json!({"stdout": "same", "durationMs": 12}))]);
        let second = result_fingerprint(&[tool(json!({"stdout": "same", "durationMs": 97}))]);
        let changed = result_fingerprint(&[tool(json!({"stdout": "new", "durationMs": 12}))]);
        assert_eq!(first, second);
        assert_ne!(first, changed);
    }
}
