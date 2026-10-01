//! Streaming collectors shared by the JSONL connectors.
//!
//! A parser feeds every raw event and projected message of one session file
//! into a collector. `FullSession` keeps everything for import;
//! `SessionTally` keeps only what a scan summary needs, so scanning large
//! histories does not hold whole transcripts in memory. Both derive the
//! summary fields with the same rules, so a scan and a later load agree.

use miniq_protocol::{ExternalSessionMessage, ExternalSessionSummary, Role};
use serde_json::Value;

use crate::common::{first_and_last_timestamp, raw_event};
use crate::{ExternalSessionEvent, ExternalSessionSnapshot};

/// Summary facts a collector derives from what it has seen.
pub(crate) struct SessionStats {
    pub(crate) message_count: usize,
    /// First non-empty user message, else the first non-empty message.
    pub(crate) title: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) updated_at: Option<String>,
}

pub(crate) trait SessionCollector: Default {
    type Output;

    fn event(
        &mut self,
        value: Value,
        sequence: usize,
        raw_id: Option<String>,
        event_type: String,
        occurred_at: Option<String>,
    );

    fn message(&mut self, message: ExternalSessionMessage);

    fn has_messages(&self) -> bool;

    fn has_user_message(&self) -> bool;

    /// Appends the messages of `other`, a collector that recorded no events.
    fn append_messages(&mut self, other: Self);

    fn finish(self, summary: impl FnOnce(SessionStats) -> ExternalSessionSummary) -> Self::Output;
}

/// Keeps every raw event and projected message for a lossless import.
#[derive(Default)]
pub(crate) struct FullSession {
    events: Vec<ExternalSessionEvent>,
    messages: Vec<ExternalSessionMessage>,
}

impl SessionCollector for FullSession {
    type Output = ExternalSessionSnapshot;

    fn event(
        &mut self,
        value: Value,
        sequence: usize,
        raw_id: Option<String>,
        event_type: String,
        occurred_at: Option<String>,
    ) {
        self.events
            .push(raw_event(value, sequence, raw_id, event_type, occurred_at));
    }

    fn message(&mut self, message: ExternalSessionMessage) {
        self.messages.push(message);
    }

    fn has_messages(&self) -> bool {
        !self.messages.is_empty()
    }

    fn has_user_message(&self) -> bool {
        self.messages
            .iter()
            .any(|message| message.role == Role::User)
    }

    fn append_messages(&mut self, mut other: Self) {
        self.messages.append(&mut other.messages);
    }

    fn finish(
        self,
        summary: impl FnOnce(SessionStats) -> ExternalSessionSummary,
    ) -> ExternalSessionSnapshot {
        let (created_at, updated_at) = first_and_last_timestamp(&self.events);
        let title = self
            .messages
            .iter()
            .find(|message| message.role == Role::User && !message.content.trim().is_empty())
            .or_else(|| {
                self.messages
                    .iter()
                    .find(|message| !message.content.trim().is_empty())
            })
            .map(|message| message.content.clone());
        let summary = summary(SessionStats {
            message_count: self.messages.len(),
            title,
            created_at,
            updated_at,
        });
        ExternalSessionSnapshot {
            summary,
            events: self.events,
            messages: self.messages,
        }
    }
}

/// Keeps counters, the time range and title candidates; every event and
/// message body is dropped as soon as it has been counted.
#[derive(Default)]
pub(crate) struct SessionTally {
    message_count: usize,
    has_user: bool,
    first_user: Option<String>,
    first_any: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

impl SessionCollector for SessionTally {
    type Output = ExternalSessionSummary;

    fn event(
        &mut self,
        _value: Value,
        _sequence: usize,
        _raw_id: Option<String>,
        _event_type: String,
        occurred_at: Option<String>,
    ) {
        let Some(occurred_at) = occurred_at else {
            return;
        };
        if self.created_at.is_none() {
            self.created_at = Some(occurred_at.clone());
        }
        self.updated_at = Some(occurred_at);
    }

    fn message(&mut self, message: ExternalSessionMessage) {
        self.message_count += 1;
        let is_user = message.role == Role::User;
        self.has_user |= is_user;
        if message.content.trim().is_empty() {
            return;
        }
        if is_user && self.first_user.is_none() {
            self.first_user = Some(message.content.clone());
        }
        if self.first_any.is_none() {
            self.first_any = Some(message.content);
        }
    }

    fn has_messages(&self) -> bool {
        self.message_count > 0
    }

    fn has_user_message(&self) -> bool {
        self.has_user
    }

    fn append_messages(&mut self, other: Self) {
        self.message_count += other.message_count;
        self.has_user |= other.has_user;
        self.first_user = self.first_user.take().or(other.first_user);
        self.first_any = self.first_any.take().or(other.first_any);
    }

    fn finish(
        self,
        summary: impl FnOnce(SessionStats) -> ExternalSessionSummary,
    ) -> ExternalSessionSummary {
        summary(SessionStats {
            message_count: self.message_count,
            title: self.first_user.or(self.first_any),
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use miniq_protocol::{ExternalContinuationMode, ExternalProvider};
    use serde_json::json;

    use super::*;

    fn message(role: Role, content: &str) -> ExternalSessionMessage {
        ExternalSessionMessage {
            event_id: content.to_owned(),
            role,
            content: content.to_owned(),
            occurred_at: None,
        }
    }

    fn feed<C: SessionCollector>(collector: &mut C) {
        collector.event(json!({}), 0, None, "a".to_owned(), None);
        collector.event(json!({}), 1, None, "b".to_owned(), Some("t1".to_owned()));
        collector.message(message(Role::Assistant, "  "));
        collector.message(message(Role::Assistant, "reply"));
        collector.event(json!({}), 2, None, "c".to_owned(), Some("t2".to_owned()));
        collector.event(json!({}), 3, None, "d".to_owned(), None);
        let mut later = C::default();
        later.message(message(Role::User, "question"));
        collector.append_messages(later);
    }

    fn summary(stats: SessionStats) -> ExternalSessionSummary {
        ExternalSessionSummary {
            provider: ExternalProvider::Codex,
            external_id: "id".to_owned(),
            title: stats.title.unwrap_or_default(),
            cwd: None,
            source_path: "path".to_owned(),
            message_count: stats.message_count,
            created_at: stats.created_at,
            updated_at: stats.updated_at,
            continuation_mode: ExternalContinuationMode::RecreateOnly,
        }
    }

    #[test]
    fn tally_summary_matches_full_session_summary() {
        let mut full = FullSession::default();
        let mut tally = SessionTally::default();
        feed(&mut full);
        feed(&mut tally);

        let snapshot = full.finish(summary);
        assert_eq!(tally.finish(summary), snapshot.summary);
        assert_eq!(snapshot.summary.title, "question");
        assert_eq!(snapshot.summary.message_count, 3);
        assert_eq!(snapshot.summary.created_at.as_deref(), Some("t1"));
        assert_eq!(snapshot.summary.updated_at.as_deref(), Some("t2"));
        assert_eq!(snapshot.events.len(), 4);
    }
}
