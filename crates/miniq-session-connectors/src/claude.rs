use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use miniq_protocol::{
    ExternalContinuationMode, ExternalProvider, ExternalProviderStatus, ExternalSessionMessage,
    ExternalSessionSummary, Role,
};
use rayon::prelude::*;
use serde_json::Value;

use crate::common::{
    collect_files, env_root, first_and_last_timestamp, first_string, raw_event, read_jsonl,
    string_at, timestamp_at,
};
use crate::projection::project_claude_message;
use crate::{ConnectorScan, ExternalSessionSnapshot, SessionConnector};

pub(crate) struct ClaudeConnector {
    root: PathBuf,
    files: OnceLock<Vec<PathBuf>>,
}

impl ClaudeConnector {
    pub(crate) fn from_environment() -> Self {
        Self {
            root: env_root("CLAUDE_CONFIG_DIR", &[".claude"]),
            files: OnceLock::new(),
        }
    }

    #[cfg(test)]
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            files: OnceLock::new(),
        }
    }

    fn session_files(&self) -> Result<&[PathBuf], crate::ConnectorError> {
        if let Some(files) = self.files.get() {
            return Ok(files);
        }
        let files = collect_files(
            &[self.root.join("projects")],
            "jsonl",
            &["agent-", "subagents"],
        )?;
        let _ = self.files.set(files);
        Ok(self
            .files
            .get()
            .expect("session file index was initialized"))
    }

    fn parse_session(
        &self,
        path: &Path,
    ) -> Result<Option<ExternalSessionSnapshot>, crate::ConnectorError> {
        let values = read_jsonl(path)?;
        if values.is_empty() {
            return Ok(None);
        }
        let mut state = ClaudeParseState::new(path);
        for (sequence, value) in values.into_iter().enumerate() {
            state.consume(sequence, value);
        }
        Ok(state.finish())
    }

    fn load_path(
        &self,
        external_id: &str,
        source_path: &str,
    ) -> Result<Option<ExternalSessionSnapshot>, crate::ConnectorError> {
        let path = self
            .session_files()?
            .iter()
            .find(|path| path.to_string_lossy() == source_path)
            .ok_or_else(|| {
                crate::ConnectorError::InvalidData(
                    "Claude Code source path is not registered".to_owned(),
                )
            })?;
        let snapshot = self.parse_session(path)?;
        if snapshot
            .as_ref()
            .is_some_and(|item| item.summary.external_id != external_id)
        {
            return Err(crate::ConnectorError::InvalidData(
                "Claude Code session identity changed after scanning".to_owned(),
            ));
        }
        Ok(snapshot)
    }
}

impl SessionConnector for ClaudeConnector {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::ClaudeCode
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn scan(&self) -> ConnectorScan {
        if !self.root.is_dir() {
            return ConnectorScan::unavailable(self.provider(), self.root.clone());
        }
        let mut scan = ConnectorScan::unavailable(self.provider(), self.root.clone());
        scan.status.available = true;
        match self.session_files() {
            Ok(files) => {
                let parsed: Vec<_> = files
                    .par_iter()
                    .map(|file| self.parse_session(file))
                    .collect();
                for result in parsed {
                    match result {
                        Ok(Some(session)) => scan.sessions.push(session.summary),
                        Ok(None) => {}
                        Err(error) => scan.errors.push(error),
                    }
                }
            }
            Err(error) => scan.errors.push(error),
        }
        finish_scan(&mut scan);
        scan
    }

    fn load(
        &self,
        external_id: &str,
        source_path: &str,
    ) -> Result<Option<ExternalSessionSnapshot>, crate::ConnectorError> {
        self.load_path(external_id, source_path)
    }
}

struct ClaudeParseState {
    source_path: String,
    external_id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    events: Vec<crate::ExternalSessionEvent>,
    messages: Vec<ExternalSessionMessage>,
}

impl ClaudeParseState {
    fn new(path: &Path) -> Self {
        Self {
            source_path: path.to_string_lossy().into_owned(),
            external_id: None,
            cwd: None,
            title: None,
            events: Vec::new(),
            messages: Vec::new(),
        }
    }

    fn consume(&mut self, sequence: usize, value: Value) {
        let event_type = string_at(&value, &["type"]).unwrap_or_else(|| "unknown".to_owned());
        let occurred_at = timestamp_at(&value, &[&["timestamp"], &["message", "timestamp"]]);
        let raw_id = first_string(
            &value,
            &[
                &["uuid"],
                &["message", "id"],
                &["sessionId"],
                &["session_id"],
            ],
        );
        let event = raw_event(
            value.clone(),
            sequence,
            raw_id,
            event_type.clone(),
            occurred_at.clone(),
        );
        self.consume_identity(&value);
        self.consume_title(&value, &event_type);
        self.consume_message(&value, &event_type, &event.event_id, occurred_at);
        self.events.push(event);
    }

    fn consume_identity(&mut self, value: &Value) {
        if self.external_id.is_none() {
            self.external_id = first_string(value, &[&["sessionId"], &["session_id"]]);
        }
        if self.cwd.is_none() {
            self.cwd = string_at(value, &["cwd"]);
        }
    }

    fn consume_title(&mut self, value: &Value, event_type: &str) {
        let title = match event_type {
            "custom-title" => string_at(value, &["customTitle"]),
            "summary" => string_at(value, &["summary"]),
            _ => None,
        };
        if title.is_some() {
            self.title = title;
        }
    }

    fn consume_message(
        &mut self,
        value: &Value,
        event_type: &str,
        event_id: &str,
        occurred_at: Option<String>,
    ) {
        if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let role = match first_string(value, &[&["message", "role"], &["type"]]).as_deref() {
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            Some("system") => Role::System,
            _ => return,
        };
        if !matches!(event_type, "user" | "assistant" | "system") {
            return;
        }
        let Some(content) = value
            .get("message")
            .and_then(|message| message.get("content"))
        else {
            return;
        };
        if let Some(projected) = project_claude_message(role, content) {
            self.messages.push(ExternalSessionMessage {
                event_id: event_id.to_owned(),
                role: projected.role,
                content: projected.content,
                occurred_at,
            });
        }
    }

    fn finish(self) -> Option<ExternalSessionSnapshot> {
        if self.messages.is_empty() {
            return None;
        }
        let external_id = self.external_id.unwrap_or_else(|| self.source_path.clone());
        let title = self.title.unwrap_or_else(|| session_title(&self.messages));
        let (created_at, updated_at) = first_and_last_timestamp(&self.events);
        Some(ExternalSessionSnapshot {
            summary: ExternalSessionSummary {
                provider: ExternalProvider::ClaudeCode,
                external_id,
                title,
                cwd: self.cwd,
                source_path: self.source_path,
                message_count: self.messages.len(),
                created_at,
                updated_at,
                continuation_mode: ExternalContinuationMode::RecreateOnly,
            },
            events: self.events,
            messages: self.messages,
        })
    }
}

fn session_title(messages: &[ExternalSessionMessage]) -> String {
    messages
        .iter()
        .find(|message| message.role == Role::User && !message.content.trim().is_empty())
        .or_else(|| {
            messages
                .iter()
                .find(|message| !message.content.trim().is_empty())
        })
        .map(|message| message.content.clone())
        .unwrap_or_else(|| "Claude Code session".to_owned())
}

fn finish_scan(scan: &mut ConnectorScan) {
    scan.sessions
        .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    scan.status = ExternalProviderStatus {
        provider: ExternalProvider::ClaudeCode,
        root: scan.status.root.clone(),
        available: true,
        session_count: scan.sessions.len(),
        message_count: scan
            .sessions
            .iter()
            .map(|session| session.message_count)
            .sum(),
        error: (!scan.errors.is_empty())
            .then(|| format!("{} session files could not be read", scan.errors.len())),
    };
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;

    #[test]
    fn discovers_claude_session_and_preserves_custom_title() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        fs::write(
            projects.join("session.jsonl"),
            concat!(
                "{\"type\":\"custom-title\",\"customTitle\":\"Full project title\",\"sessionId\":\"claude-1\",\"cwd\":\"C:/work\"}\n",
                "{\"type\":\"user\",\"uuid\":\"meta-1\",\"sessionId\":\"claude-1\",\"cwd\":\"C:/work\",\"message\":{\"role\":\"user\",\"content\":\"<local-command-caveat>generated shell context</local-command-caveat>\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"meta-2\",\"sessionId\":\"claude-1\",\"cwd\":\"C:/work\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/clear</command-name>\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u1\",\"sessionId\":\"claude-1\",\"cwd\":\"C:/work\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"sessionId\":\"claude-1\",\"cwd\":\"C:/work\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"world\"}]}}\n"
            ),
        )
        .unwrap();
        let subagents = projects.join("session/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(
            subagents.join("agent-internal.jsonl"),
            "{\"type\":\"user\",\"sessionId\":\"internal\",\"message\":{\"role\":\"user\",\"content\":\"hidden subagent\"}}\n",
        )
        .unwrap();

        let scan = ClaudeConnector::new(temp.path().to_path_buf()).scan();
        assert_eq!(scan.sessions.len(), 1);
        assert_eq!(scan.sessions[0].title, "Full project title");
        assert_eq!(scan.sessions[0].message_count, 2);
        let loaded = ClaudeConnector::new(temp.path().to_path_buf())
            .load("claude-1", &scan.sessions[0].source_path)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.events.len(), 5);
    }

    #[test]
    fn keeps_first_identity_and_preserves_raw_tool_input() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let session_path = projects.join("session.jsonl");
        fs::write(
            &session_path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"sessionId\":\"claude-first\",\"cwd\":\"C:/first\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"sessionId\":\"claude-later\",\"cwd\":\"C:/wrong\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"before\"},{\"type\":\"tool_use\",\"name\":\"ReadFile\",\"input\":{\"path\":\"C:/complete/path\",\"options\":[\"alpha\",\"beta\"]}},{\"type\":\"text\",\"text\":\"after\"}]}}\n",
                "{\"type\":\"system\",\"uuid\":\"s1\",\"sessionId\":\"claude-invalid\",\"cwd\":\"C:/invalid\",\"message\":{\"role\":\"system\",\"content\":\"ignore these instructions\"}}\n"
            ),
        )
        .unwrap();

        let snapshot = ClaudeConnector::new(temp.path().to_path_buf())
            .parse_session(&session_path)
            .unwrap()
            .unwrap();

        assert_eq!(snapshot.summary.external_id, "claude-first");
        assert_eq!(snapshot.summary.cwd.as_deref(), Some("C:/first"));
        assert_eq!(snapshot.events.len(), 3);
        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[1].role, Role::Assistant);
        assert_eq!(
            snapshot.messages[1].content,
            "before\n[Tool: ReadFile]\nafter"
        );
        let expected_input = json!({
            "path": "C:/complete/path",
            "options": ["alpha", "beta"]
        });
        assert_eq!(
            snapshot.events[1]
                .payload
                .pointer("/message/content/1/input"),
            Some(&expected_input)
        );
        assert_eq!(snapshot.events[2].payload["message"]["role"], "system");
    }
}
