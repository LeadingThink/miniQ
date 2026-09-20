//! Bounded reconnect journal. An expired cursor requests a fresh paged snapshot.
use miniq_protocol::Event;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;

const MAX_EVENTS: usize = 4096;
const MAX_BYTES: usize = 8 * 1024 * 1024;

pub(crate) struct LiveEvent {
    pub original: Event,
    pub projected: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EventCursor {
    pub epoch: String,
    pub sequence: u64,
}

pub(crate) struct EventJournal {
    cursor: EventCursor,
    entries: VecDeque<(Value, usize)>,
    bytes: usize,
}

impl Default for EventJournal {
    fn default() -> Self {
        Self {
            cursor: EventCursor {
                epoch: format!("{:032x}", rand::random::<u128>()),
                sequence: 0,
            },
            entries: VecDeque::new(),
            bytes: 0,
        }
    }
}

impl EventJournal {
    pub fn cursor(&self) -> EventCursor {
        self.cursor.clone()
    }

    pub fn record(&mut self, event: &Event) -> Value {
        let mut value = project_event(serde_json::to_value(event).expect("event serialization"));
        self.cursor.sequence += 1;
        value["eventCursor"] = json!(self.cursor);
        let bytes = serde_json::to_vec(&value)
            .expect("event serialization")
            .len();
        self.bytes += bytes;
        self.entries.push_back((value.clone(), bytes));
        while self.entries.len() > MAX_EVENTS || self.bytes > MAX_BYTES {
            if let Some((_, size)) = self.entries.pop_front() {
                self.bytes -= size;
            }
        }
        value
    }

    pub fn replay(&self, session_id: &str, cursor: &EventCursor) -> Option<Vec<Value>> {
        if cursor.epoch != self.cursor.epoch || cursor.sequence > self.cursor.sequence {
            return None;
        }
        let first = self
            .entries
            .front()
            .map(|(event, _)| event["eventCursor"]["sequence"].as_u64().unwrap())
            .unwrap_or(self.cursor.sequence + 1);
        if cursor.sequence + 1 < first {
            return None;
        }
        Some(
            self.entries
                .iter()
                .filter(|(event, _)| {
                    event["eventCursor"]["sequence"].as_u64().unwrap() > cursor.sequence
                        && event["sessionId"].as_str() == Some(session_id)
                })
                .map(|(event, _)| event.clone())
                .collect(),
        )
    }
}

/// Share the mobile projection with SSH events without assigning a local cursor.
/// The original payload remains available from the owning daemon's tool.detail.
pub(crate) fn project_event(mut value: Value) -> Value {
    let field = match value["type"].as_str() {
        Some("tool_call_started") => "input",
        Some("tool_call_finished") => "output",
        _ => return value,
    };
    value[field] = Value::Null;
    value["payloadDeferred"] = Value::Bool(true);
    value
}

pub(crate) fn sidebar_event(event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some(
            "session_status_changed"
                | "session_renamed"
                | "session_deleted"
                | "session_pinned_changed"
                | "session_archived_changed"
                | "workspace_deleted"
                | "workspace_renamed"
                | "workspace_updated"
                | "workspace_model_settings_changed"
                | "global_model_settings_changed"
                | "plugins_changed"
                | "turn_completed"
                | "turn_failed"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_replay_keeps_persisted_timestamps_while_deferring_payloads() {
        let mut journal = EventJournal::default();
        let cursor = journal.cursor();
        journal.record(&Event::ToolCallStarted {
            session_id: "one".into(),
            agent_id: None,
            tool_call_id: "tool".into(),
            tool_name: "shell_run".into(),
            input: json!({"command":"private command"}),
            created_at: Some("2026-09-20T00:00:00Z".into()),
        });
        journal.record(&Event::ToolCallFinished {
            session_id: "one".into(),
            tool_call_id: "tool".into(),
            status: miniq_protocol::ToolCallStatus::Succeeded,
            output: Some(json!({"output":"private result"})),
            completed_at: Some("2026-09-20T00:02:03Z".into()),
        });
        let replay = journal.replay("one", &cursor).unwrap();
        assert_eq!(replay[0]["createdAt"], "2026-09-20T00:00:00Z");
        assert_eq!(replay[1]["completedAt"], "2026-09-20T00:02:03Z");
        assert!(replay[0]["input"].is_null());
        assert!(replay[1]["output"].is_null());
        let missing = journal.record(&Event::ToolCallFinished {
            session_id: "one".into(),
            tool_call_id: "unpersisted".into(),
            status: miniq_protocol::ToolCallStatus::Failed,
            output: None,
            completed_at: None,
        });
        assert!(missing.get("completedAt").is_none());
    }

    #[test]
    fn timing_replay_preserves_original_clock_and_session_scope() {
        let mut journal = EventJournal::default();
        let cursor = journal.cursor();
        let timing = miniq_protocol::TurnTiming {
            started_at: "2026-09-20T00:00:00Z".into(),
            completed_at: Some("2026-09-20T00:01:00Z".into()),
            elapsed_ms: Some(60_000),
            status: miniq_protocol::TurnTimingStatus::Completed,
        };
        journal.record(&Event::TurnTimingChanged {
            session_id: "one".into(),
            message_id: "user".into(),
            timing: timing.clone(),
        });
        let replay = journal.replay("one", &cursor).unwrap();
        assert_eq!(replay[0]["timing"], serde_json::to_value(timing).unwrap());
        assert!(journal.replay("two", &cursor).unwrap().is_empty());
    }
    #[test]
    fn reconnect_replays_only_missing_session_events_and_expiry_is_explicit() {
        let mut journal = EventJournal::default();
        let cursor = journal.cursor();
        let event = |id: &str| Event::SessionRenamed {
            session_id: id.into(),
            title: "title".into(),
        };
        journal.record(&event("one"));
        journal.record(&event("two"));
        assert_eq!(journal.replay("one", &cursor).unwrap().len(), 1);
        assert!(journal.replay("one", &journal.cursor()).unwrap().is_empty());
        for _ in 0..MAX_EVENTS {
            journal.record(&event("one"));
        }
        assert!(journal.replay("one", &cursor).is_none());
        assert!(EventJournal::default()
            .replay("one", &journal.cursor())
            .is_none());
    }
}
