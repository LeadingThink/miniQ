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
        // Tool bodies are fetched through tool.detail, including for live events.
        let mut value = match event {
            Event::ToolCallStarted {
                session_id,
                tool_call_id,
                tool_name,
                ..
            } => json!({
                "type": "tool_call_started", "sessionId": session_id, "toolCallId": tool_call_id,
                "toolName": tool_name, "input": null, "payloadDeferred": true,
            }),
            Event::ToolCallFinished {
                session_id,
                tool_call_id,
                status,
                ..
            } => json!({
                "type": "tool_call_finished", "sessionId": session_id, "toolCallId": tool_call_id,
                "status": status, "output": null, "payloadDeferred": true,
            }),
            _ => serde_json::to_value(event).expect("event serialization"),
        };
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
