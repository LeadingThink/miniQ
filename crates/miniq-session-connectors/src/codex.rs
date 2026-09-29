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

use crate::collector::{FullSession, SessionCollector, SessionTally};
use crate::common::{
    content_text, env_root, first_string, for_each_jsonl, string_at, timestamp_at, SessionFileIndex,
};
use crate::projection::projected_content;
use crate::{ConnectorScan, ExternalSessionSnapshot, SessionConnector};
use title_catalog::CodexTitleCatalog;

pub(crate) struct CodexConnector {
    root: PathBuf,
    files: OnceLock<SessionFileIndex>,
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

    fn session_files(&self) -> Result<&SessionFileIndex, crate::ConnectorError> {
        if let Some(files) = self.files.get() {
            return Ok(files);
        }
        let files = SessionFileIndex::collect(
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
        parse_file::<FullSession>(path, self.title_catalog())
    }

    fn load_path(
        &self,
        external_id: &str,
        source_path: &str,
    ) -> Result<Option<ExternalSessionSnapshot>, crate::ConnectorError> {
        let path = self.session_files()?.get(source_path).ok_or_else(|| {
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

    fn prepare(&self) -> Result<(), crate::ConnectorError> {
        self.session_files()?;
        self.title_catalog();
        Ok(())
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
                    .files()
                    .par_iter()
                    .map(|file| parse_file::<SessionTally>(file, titles))
                    .collect();
                for result in parsed {
                    match result {
                        Ok(Some(summary)) => scan.sessions.push(summary),
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

fn parse_file<C: SessionCollector>(
    path: &Path,
    titles: &CodexTitleCatalog,
) -> Result<Option<C::Output>, crate::ConnectorError> {
    let mut state = CodexParseState::<C>::new(path);
    for_each_jsonl(path, |sequence, value| state.consume(sequence, value))?;
    Ok(state.finish(titles))
}

struct CodexParseState<C> {
    source_path: String,
    external_id: Option<String>,
    cwd: Option<String>,
    collector: C,
    /// `event_msg` user messages; used only when no `response_item` user
    /// message exists, since both usually mirror the same prompt.
    event_user: C,
}

impl<C: SessionCollector> CodexParseState<C> {
    fn new(path: &Path) -> Self {
        Self {
            source_path: path.to_string_lossy().into_owned(),
            external_id: None,
            cwd: None,
            collector: C::default(),
            event_user: C::default(),
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
        let event_id = raw_id
            .as_ref()
            .map(|id| format!("{sequence}:{id}"))
            .unwrap_or_else(|| sequence.to_string());
        match event_type.as_str() {
            "session_meta" => self.consume_metadata(&value),
            "response_item" => self.consume_response_item(&value, &event_id, occurred_at.clone()),
            "event_msg" => self.consume_event_message(&value, &event_id, occurred_at.clone()),
            _ => {}
        }
        self.collector
            .event(value, sequence, raw_id, event_type, occurred_at);
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
            self.collector.message(ExternalSessionMessage {
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
            self.event_user.message(ExternalSessionMessage {
                event_id: event_id.to_owned(),
                role: Role::User,
                content,
                occurred_at,
            });
        }
    }

    fn finish(self, titles: &CodexTitleCatalog) -> Option<C::Output> {
        let mut collector = self.collector;
        if !collector.has_user_message() {
            collector.append_messages(self.event_user);
        }
        if !collector.has_messages() {
            return None;
        }
        let external_id = self.external_id.unwrap_or_else(|| self.source_path.clone());
        let catalog_title = titles.get(&external_id).map(ToOwned::to_owned);
        let (cwd, source_path) = (self.cwd, self.source_path);
        Some(collector.finish(|stats| {
            ExternalSessionSummary {
                provider: ExternalProvider::Codex,
                external_id,
                title: catalog_title
                    .or(stats.title)
                    .unwrap_or_else(|| "Codex session".to_owned()),
                cwd,
                source_path,
                message_count: stats.message_count,
                created_at: stats.created_at,
                updated_at: stats.updated_at,
                continuation_mode: ExternalContinuationMode::RecreateOnly,
            }
        }))
    }
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

    #[test]
    fn scan_summary_matches_loaded_summary_for_event_only_user_messages() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("session.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-3\"}}\n",
                "\n",
                "{\"timestamp\":\"2026-01-01T00:00:01Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"a\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ready\"}]}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"event prompt\"}}\n"
            ),
        )
        .unwrap();

        let connector = CodexConnector::new(temp.path().to_path_buf());
        let scan = connector.scan();
        assert_eq!(scan.sessions.len(), 1);
        let loaded = connector
            .load("codex-3", &scan.sessions[0].source_path)
            .unwrap()
            .unwrap();
        assert_eq!(scan.sessions[0], loaded.summary);
        assert_eq!(loaded.summary.title, "event prompt");
        assert_eq!(loaded.summary.message_count, 2);
        assert_eq!(loaded.events.len(), 3);
        assert_eq!(loaded.events[2].sequence, 2);
    }
}
