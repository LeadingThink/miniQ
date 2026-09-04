use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use miniq_protocol::{
    ExternalContinuationMode, ExternalProvider, ExternalSessionMessage, ExternalSessionSummary,
    Role,
};
use rayon::prelude::*;
use serde_json::Value;

#[path = "codex_title_catalog.rs"]
mod title_catalog;

use crate::common::{
    collect_files, content_text, env_root, first_and_last_timestamp, first_string, raw_event,
    read_jsonl, string_at, timestamp_at,
};
use crate::projection::projected_content;
use crate::{ConnectorScan, ExternalSessionSnapshot, SessionConnector};
use title_catalog::CodexTitleCatalog;

pub(crate) struct CodexConnector {
    root: PathBuf,
    files: OnceLock<Vec<PathBuf>>,
    titles: OnceLock<CodexTitleCatalog>,
}

impl CodexConnector {
    pub(crate) fn from_environment() -> Self {
        Self {
            root: env_root("CODEX_HOME", &[".codex"]),
            files: OnceLock::new(),
            titles: OnceLock::new(),
        }
    }

    #[cfg(test)]
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            files: OnceLock::new(),
            titles: OnceLock::new(),
        }
    }

    fn session_files(&self) -> Result<&[PathBuf], crate::ConnectorError> {
        if let Some(files) = self.files.get() {
            return Ok(files);
        }
        let files = collect_files(
            &[
                self.root.join("sessions"),
                self.root.join("archived_sessions"),
            ],
            "jsonl",
            &[],
        )?;
        let _ = self.files.set(files);
        Ok(self
            .files
            .get()
            .expect("session file index was initialized"))
    }

    fn title_catalog(&self) -> &CodexTitleCatalog {
        self.titles
            .get_or_init(|| CodexTitleCatalog::load(&self.root))
    }

    fn parse_session(
        &self,
        path: &Path,
    ) -> Result<Option<ExternalSessionSnapshot>, crate::ConnectorError> {
        self.parse_session_with_titles(path, self.title_catalog())
    }

    fn parse_session_with_titles(
        &self,
        path: &Path,
        titles: &CodexTitleCatalog,
    ) -> Result<Option<ExternalSessionSnapshot>, crate::ConnectorError> {
        let values = read_jsonl(path)?;
        if values.is_empty() {
            return Ok(None);
        }
        let mut state = CodexParseState::new(path);
        for (sequence, value) in values.into_iter().enumerate() {
            state.consume(sequence, value);
        }
        Ok(state.finish(titles))
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
                crate::ConnectorError::InvalidData("Codex source path is not registered".to_owned())
            })?;
        let snapshot = self.parse_session(path)?;
        if snapshot
            .as_ref()
            .is_some_and(|item| item.summary.external_id != external_id)
        {
            return Err(crate::ConnectorError::InvalidData(
                "Codex session identity changed after scanning".to_owned(),
            ));
        }
        Ok(snapshot)
    }
}

impl SessionConnector for CodexConnector {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::Codex
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
                let titles = self.title_catalog();
                let parsed: Vec<_> = files
                    .par_iter()
                    .map(|file| self.parse_session_with_titles(file, titles))
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

struct CodexParseState {
    source_path: String,
    external_id: Option<String>,
    cwd: Option<String>,
    events: Vec<crate::ExternalSessionEvent>,
    messages: Vec<ExternalSessionMessage>,
    event_user_messages: Vec<ExternalSessionMessage>,
}

impl CodexParseState {
    fn new(path: &Path) -> Self {
        Self {
            source_path: path.to_string_lossy().into_owned(),
            external_id: None,
            cwd: None,
            events: Vec::new(),
            messages: Vec::new(),
            event_user_messages: Vec::new(),
        }
    }

    fn consume(&mut self, sequence: usize, value: Value) {
        let event_type = string_at(&value, &["type"]).unwrap_or_else(|| "unknown".to_owned());
        let occurred_at = timestamp_at(&value, &[&["timestamp"], &["payload", "timestamp"]]);
        let raw_id = first_string(
            &value,
            &[
                &["id"],
                &["payload", "id"],
                &["payload", "call_id"],
                &["payload", "session_id"],
            ],
        );
        let event = raw_event(
            value.clone(),
            sequence,
            raw_id,
            event_type.clone(),
            occurred_at.clone(),
        );
        match event_type.as_str() {
            "session_meta" => self.consume_metadata(&value),
            "response_item" => self.consume_response_item(&value, &event.event_id, occurred_at),
            "event_msg" => self.consume_event_message(&value, &event.event_id, occurred_at),
            _ => {}
        }
        self.events.push(event);
    }

    fn consume_metadata(&mut self, value: &Value) {
        if self.external_id.is_none() {
            self.external_id = first_string(
                value,
                &[
                    &["payload", "id"],
                    &["payload", "session_id"],
                    &["id"],
                    &["session_id"],
                ],
            );
        }
        if self.cwd.is_none() {
            self.cwd = first_string(value, &[&["payload", "cwd"], &["cwd"]]);
        }
    }

    fn consume_response_item(
        &mut self,
        value: &Value,
        event_id: &str,
        occurred_at: Option<String>,
    ) {
        if string_at(value, &["payload", "type"]).as_deref() != Some("message") {
            return;
        }
        let role = match string_at(value, &["payload", "role"]).as_deref() {
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            Some("system") => Role::System,
            _ => return,
        };
        let content = value
            .get("payload")
            .and_then(|payload| payload.get("content"))
            .map(content_text)
            .unwrap_or_default();
        if let Some(content) = projected_content(ExternalProvider::Codex, role, content) {
            self.messages.push(ExternalSessionMessage {
                event_id: event_id.to_owned(),
                role,
                content,
                occurred_at,
            });
        }
    }

    fn consume_event_message(
        &mut self,
        value: &Value,
        event_id: &str,
        occurred_at: Option<String>,
    ) {
        if string_at(value, &["payload", "type"]).as_deref() != Some("user_message") {
            return;
        }
        let content = value
            .get("payload")
            .and_then(|payload| payload.get("message"))
            .map(content_text)
            .unwrap_or_default();
        if let Some(content) = projected_content(ExternalProvider::Codex, Role::User, content) {
            self.event_user_messages.push(ExternalSessionMessage {
                event_id: event_id.to_owned(),
                role: Role::User,
                content,
                occurred_at,
            });
        }
    }

    fn finish(mut self, titles: &CodexTitleCatalog) -> Option<ExternalSessionSnapshot> {
        if !self
            .messages
            .iter()
            .any(|message| message.role == Role::User)
        {
            self.messages.append(&mut self.event_user_messages);
        }
        if self.messages.is_empty() {
            return None;
        }
        let external_id = self.external_id.unwrap_or_else(|| self.source_path.clone());
        let title = titles
            .get(&external_id)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| session_title(&self.messages, "Codex session"));
        let (created_at, updated_at) = first_and_last_timestamp(&self.events);
        Some(ExternalSessionSnapshot {
            summary: ExternalSessionSummary {
                provider: ExternalProvider::Codex,
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

fn session_title(messages: &[ExternalSessionMessage], fallback: &str) -> String {
    messages
        .iter()
        .find(|message| message.role == Role::User && !message.content.trim().is_empty())
        .or_else(|| {
            messages
                .iter()
                .find(|message| !message.content.trim().is_empty())
        })
        .map(|message| message.content.clone())
        .unwrap_or_else(|| fallback.to_owned())
}

fn finish_scan(scan: &mut ConnectorScan) {
    scan.sessions
        .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    scan.status.session_count = scan.sessions.len();
    scan.status.message_count = scan
        .sessions
        .iter()
        .map(|session| session.message_count)
        .sum();
    if !scan.errors.is_empty() {
        scan.status.error = Some(format!(
            "{} session files could not be read",
            scan.errors.len()
        ));
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::{params, Connection};

    use super::*;

    fn write_title_database(path: &Path, titles: &[(&str, &str)]) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)")
            .unwrap();
        for (id, title) in titles {
            connection
                .execute(
                    "INSERT INTO threads (id, title) VALUES (?1, ?2)",
                    params![id, title],
                )
                .unwrap();
        }
    }

    #[test]
    fn falls_back_to_message_title_when_catalog_table_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        Connection::open(temp.path().join("state_1.sqlite"))
            .unwrap()
            .execute_batch("CREATE TABLE unrelated (id TEXT PRIMARY KEY)")
            .unwrap();
        fs::write(
            sessions.join("session.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-1\",\"cwd\":\"C:/work\"}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hello\"}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:01Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"m2\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"world\"}]}}\n"
            ),
        )
        .unwrap();

        let scan = CodexConnector::new(temp.path().to_path_buf()).scan();
        assert_eq!(scan.sessions.len(), 1);
        assert_eq!(scan.sessions[0].external_id, "codex-1");
        assert_eq!(scan.sessions[0].message_count, 2);
        assert_eq!(scan.sessions[0].title, "hello");
        let loaded = CodexConnector::new(temp.path().to_path_buf())
            .load("codex-1", &scan.sessions[0].source_path)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.events.len(), 4);
    }

    #[test]
    fn uses_full_title_from_highest_versioned_state_database() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-title\",\"cwd\":\"C:/work\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"id\":\"user\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"fallback title\"}]}}\n"
            ),
        )
        .unwrap();
        write_title_database(
            &temp.path().join("state_2.sqlite"),
            &[("codex-title", "Old title")],
        );
        let official_title = "Official title preserved in full even when it is intentionally longer than eighty characters for this regression";
        write_title_database(
            &temp.path().join("state_12.sqlite"),
            &[("codex-title", official_title)],
        );

        let scan = CodexConnector::new(temp.path().to_path_buf()).scan();
        assert_eq!(scan.sessions.len(), 1);
        assert_eq!(scan.sessions[0].title, official_title);
    }

    #[test]
    fn keeps_first_valid_session_identity_and_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let session_path = sessions.join("session.jsonl");
        fs::write(
            &session_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"stable-id\",\"cwd\":\"C:/stable\"}}\n",
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong-id\",\"cwd\":\"C:/wrong\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"id\":\"user\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}\n"
            ),
        )
        .unwrap();

        let snapshot = CodexConnector::new(temp.path().to_path_buf())
            .parse_session(&session_path)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.summary.external_id, "stable-id");
        assert_eq!(snapshot.summary.cwd.as_deref(), Some("C:/stable"));
        assert_eq!(snapshot.events[1].payload["payload"]["id"], "wrong-id");
    }

    #[test]
    fn excludes_codex_runtime_preamble_from_projected_history() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-2\",\"cwd\":\"C:/work\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"id\":\"preamble\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions\\n<environment_context>private runtime metadata</environment_context>\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"id\":\"user\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"actual request\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"id\":\"assistant\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"answer\"}]}}\n"
            ),
        )
        .unwrap();

        let snapshot = CodexConnector::new(temp.path().to_path_buf())
            .parse_session(&sessions.join("session.jsonl"))
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.events.len(), 4);
        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[0].content, "actual request");
        assert_eq!(snapshot.summary.title, "actual request");
    }
}
