//! Encrypted offline push frames.
//!
//! The daemon decides *what* deserves a phone notification; the relay only
//! decides *whether* a phone needs a system push (it is offline or in the
//! background) and forwards the ciphertext to APNs / the vendor gateway.
//! The relay never sees session titles or errors in clear text.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use aes_gcm::Aes256Gcm;
use miniq_protocol::{Event, SessionStatus};
use serde_json::{json, Value};

use crate::state::AppState;

/// Completed turns shorter than this are not worth a phone notification.
/// Mirrors `SHORT_TASK_MS` in apps/desktop/src/hooks/useTaskNotifications.ts.
pub(super) const SHORT_TASK: Duration = Duration::from_secs(10);
const MAX_TITLE_CHARS: usize = 80;
const MAX_ERROR_CHARS: usize = 160;
const MAX_DETAIL_CHARS: usize = 120;
const MAX_TRACKED_SESSIONS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PushKind {
    Completed,
    Failed,
    Attention,
}

impl PushKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Attention => "attention",
        }
    }
}

/// The approval a notification can resolve directly ("批准 / 拒绝" actions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PushApproval {
    pub id: String,
    pub tool: String,
    pub reason: String,
}

/// What a push frame is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PushEvent {
    pub kind: PushKind,
    pub session_id: String,
    pub error: Option<String>,
    pub approval: Option<PushApproval>,
}

impl PushEvent {
    fn new(kind: PushKind, session_id: &str) -> Self {
        Self {
            kind,
            session_id: session_id.to_string(),
            error: None,
            approval: None,
        }
    }
}

/// Per-connection rules: one push per waiting episode, no push for short turns.
///
/// The executor emits `SessionStatusChanged(WaitingApproval)` immediately
/// followed by `ApprovalRequested` / `QuestionRequested`; the push is sent on
/// the second event so it can carry the approval id for notification actions.
#[derive(Default)]
pub(super) struct PushTracker {
    started: HashMap<String, Instant>,
    waiting: HashSet<String>,
    notified: HashSet<String>,
}

impl PushTracker {
    /// Returns the push kind for an event, if it deserves a push.
    pub(super) fn observe(&mut self, event: &Event, now: Instant) -> Option<PushEvent> {
        match event {
            Event::SessionStatusChanged { session_id, status } => {
                if *status != SessionStatus::WaitingApproval {
                    self.waiting.remove(session_id);
                    self.notified.remove(session_id);
                }
                match status {
                    SessionStatus::Running => {
                        if self.started.len() >= MAX_TRACKED_SESSIONS {
                            self.started.clear();
                        }
                        self.started.entry(session_id.clone()).or_insert(now);
                        None
                    }
                    SessionStatus::WaitingApproval => {
                        if self.waiting.len() >= MAX_TRACKED_SESSIONS {
                            self.waiting.clear();
                            self.notified.clear();
                        }
                        self.waiting.insert(session_id.clone());
                        None
                    }
                    _ => None,
                }
            }
            Event::ApprovalRequested {
                session_id,
                approval,
                tool_name,
                ..
            } => self.attention(session_id).map(|mut push| {
                push.approval = Some(PushApproval {
                    id: approval.id.clone(),
                    tool: truncate(tool_name, MAX_DETAIL_CHARS),
                    reason: truncate(&approval.reason, MAX_DETAIL_CHARS),
                });
                push
            }),
            Event::QuestionRequested { session_id, .. } => self.attention(session_id),
            Event::TurnCompleted { session_id, .. } => {
                let started = self.started.remove(session_id);
                if started.is_some_and(|at| now.saturating_duration_since(at) < SHORT_TASK) {
                    return None;
                }
                Some(PushEvent::new(PushKind::Completed, session_id))
            }
            Event::TurnFailed {
                session_id, error, ..
            } => {
                self.started.remove(session_id);
                let mut push = PushEvent::new(PushKind::Failed, session_id);
                push.error = Some(error.clone());
                Some(push)
            }
            Event::SessionDeleted { session_id } => {
                self.started.remove(session_id);
                self.waiting.remove(session_id);
                self.notified.remove(session_id);
                None
            }
            _ => None,
        }
    }

    /// One attention push per waiting episode. A request seen without the
    /// status change (e.g. a dropped event) still notifies once.
    fn attention(&mut self, session_id: &str) -> Option<PushEvent> {
        self.waiting.insert(session_id.to_string());
        self.notified
            .insert(session_id.to_string())
            .then(|| PushEvent::new(PushKind::Attention, session_id))
    }
}

/// Same hash as `notificationId({ host: null, sessionId })` in
/// apps/desktop/src/taskNotifications.ts, so a remote push and a local
/// notification for one session replace each other on the phone.
pub(super) fn notification_id(session_id: &str) -> i32 {
    let mut hash: i32 = 0;
    for unit in std::iter::once(0_u16).chain(session_id.encode_utf16()) {
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
    }
    match hash & 0x7fff_ffff {
        0 => 1,
        value => value,
    }
}

fn truncate(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut value: String = trimmed.chars().take(limit.saturating_sub(1)).collect();
    value.push('…');
    value
}

/// Builds the relay-level `push` message. Only the kind (needed for the
/// interruption level) and the collapse id (a hash) are visible to the relay.
pub(super) fn push_message(
    state: &AppState,
    cipher: &Aes256Gcm,
    push: &PushEvent,
) -> anyhow::Result<Value> {
    let kind = push.kind;
    let session_id = push.session_id.as_str();
    let title = state
        .store
        .get_session(session_id)
        .map(|session| truncate(&session.title, MAX_TITLE_CHARS))
        .unwrap_or_default();
    let collapse_id = notification_id(session_id).to_string();
    let mut payload = json!({
        "v": 1,
        "kind": kind.as_str(),
        "sessionId": session_id,
        "title": title,
        "error": push.error.as_deref().map(|error| truncate(error, MAX_ERROR_CHARS)),
        "notificationId": collapse_id,
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default(),
    });
    if let Some(approval) = &push.approval {
        payload["approvalId"] = json!(approval.id);
        payload["toolName"] = json!(approval.tool);
        payload["reason"] = json!(approval.reason);
    }
    let (nonce, ciphertext) = super::encrypt_payload(cipher, &serde_json::to_vec(&payload)?)?;
    Ok(json!({
        "type": "push",
        "kind": kind.as_str(),
        "collapseId": collapse_id,
        "nonce": nonce,
        "ciphertext": ciphertext,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(session: &str, status: SessionStatus) -> Event {
        Event::SessionStatusChanged {
            session_id: session.into(),
            status,
        }
    }

    #[test]
    fn notification_id_matches_frontend_hash() {
        // Values computed with notificationId({ host: null, sessionId }) in taskNotifications.ts.
        assert_eq!(notification_id(""), 1);
        let expected = {
            let text = "\u{0}abc";
            let mut hash: i32 = 0;
            for unit in text.encode_utf16() {
                hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
            }
            hash & 0x7fff_ffff
        };
        assert_eq!(notification_id("abc"), expected);
        assert!(notification_id("0198f0a2-5c1e-7000-8000-000000000000") > 0);
    }

    #[test]
    fn short_turns_are_not_pushed() {
        let mut tracker = PushTracker::default();
        let start = Instant::now();
        assert!(tracker
            .observe(&status("s", SessionStatus::Running), start)
            .is_none());
        let done = Event::TurnCompleted {
            session_id: "s".into(),
            summary: None,
        };
        assert!(tracker
            .observe(&done, start + Duration::from_secs(3))
            .is_none());
        tracker.observe(&status("s", SessionStatus::Running), start);
        let pushed = tracker.observe(&done, start + Duration::from_secs(11));
        assert_eq!(pushed.map(|value| value.kind), Some(PushKind::Completed));
    }

    #[test]
    fn failures_are_always_pushed() {
        let mut tracker = PushTracker::default();
        let start = Instant::now();
        tracker.observe(&status("s", SessionStatus::Running), start);
        let failed = Event::TurnFailed {
            session_id: "s".into(),
            error: "boom".into(),
            summary: None,
        };
        let pushed = tracker
            .observe(&failed, start + Duration::from_secs(1))
            .unwrap();
        assert_eq!(pushed.kind, PushKind::Failed);
        assert_eq!(pushed.error.as_deref(), Some("boom"));
    }

    fn approval_requested(session: &str, id: &str) -> Event {
        let approval: miniq_protocol::Approval = serde_json::from_value(json!({
            "id": id,
            "sessionId": session,
            "toolCallId": "call",
            "riskLevel": "high",
            "status": "pending",
            "reason": "writes outside the workspace",
            "createdAt": "2024-01-01T00:00:00Z",
        }))
        .unwrap();
        Event::ApprovalRequested {
            session_id: session.into(),
            approval,
            tool_name: "shell_run".into(),
            input: json!({}),
            risk_level: miniq_protocol::RiskLevel::High,
        }
    }

    #[test]
    fn waiting_is_pushed_once_per_episode() {
        let mut tracker = PushTracker::default();
        let now = Instant::now();
        assert!(tracker
            .observe(&status("s", SessionStatus::WaitingApproval), now)
            .is_none());
        let pushed = tracker
            .observe(&approval_requested("s", "a1"), now)
            .unwrap();
        assert_eq!(pushed.kind, PushKind::Attention);
        assert_eq!(pushed.approval.as_ref().map(|a| a.id.as_str()), Some("a1"));
        assert_eq!(
            pushed.approval.as_ref().map(|a| a.tool.as_str()),
            Some("shell_run")
        );
        // A parallel approval in the same episode does not ring again.
        assert!(tracker
            .observe(&status("s", SessionStatus::WaitingApproval), now)
            .is_none());
        assert!(tracker
            .observe(&approval_requested("s", "a2"), now)
            .is_none());
        tracker.observe(&status("s", SessionStatus::Running), now);
        tracker.observe(&status("s", SessionStatus::WaitingApproval), now);
        assert_eq!(
            tracker
                .observe(&approval_requested("s", "a3"), now)
                .map(|v| v.kind),
            Some(PushKind::Attention)
        );
    }

    #[test]
    fn long_titles_are_truncated() {
        assert_eq!(truncate("  short  ", 10), "short");
        assert_eq!(truncate("abcdefghijkl", 5).chars().count(), 5);
    }
}
