use std::path::{Path, PathBuf};
use std::time::Duration;

use miniq_protocol::{
    ExternalContinuationMode, ExternalProvider, ExternalProviderStatus, ExternalSessionEvent,
    ExternalSessionMessage, ExternalSessionSnapshot, ExternalSessionSummary, Role,
};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags, Row, Transaction};
use serde_json::{Map, Number, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::common::{env_root, first_and_last_timestamp};
use crate::projection::projected_content;
use crate::{ConnectorError, ConnectorScan, SessionConnector};

pub(crate) struct OpenCodeConnector {
    root: PathBuf,
    database: PathBuf,
}

impl OpenCodeConnector {
    pub(crate) fn from_environment() -> Self {
        let root = std::env::var_os("OPENCODE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| env_root("XDG_DATA_HOME", &[".local", "share"]).join("opencode"));
        let database = database_path(&root);
        Self { root, database }
    }

    #[cfg(test)]
    fn new(root: PathBuf, database: PathBuf) -> Self {
        Self { root, database }
    }

    fn scan_database(&self) -> Result<Vec<ExternalSessionSummary>, ConnectorError> {
        let mut connection =
            Connection::open_with_flags(&self.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|source| self.sqlite_error(source))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|source| self.sqlite_error(source))?;
        let transaction = connection
            .transaction()
            .map_err(|source| self.sqlite_error(source))?;
        validate_schema(&transaction).map_err(|source| self.sqlite_error(source))?;
        let sessions = load_session_summaries(&transaction, &self.database)?;
        transaction
            .commit()
            .map_err(|source| self.sqlite_error(source))?;
        Ok(sessions)
    }

    fn load_database(
        &self,
        external_id: &str,
    ) -> Result<Option<ExternalSessionSnapshot>, ConnectorError> {
        let mut connection =
            Connection::open_with_flags(&self.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|source| self.sqlite_error(source))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|source| self.sqlite_error(source))?;
        let transaction = connection
            .transaction()
            .map_err(|source| self.sqlite_error(source))?;
        validate_schema(&transaction).map_err(|source| self.sqlite_error(source))?;
        let mut rows = query_json_rows(
            &transaction,
            "SELECT * FROM session WHERE id = ?1",
            params![external_id],
            &self.database,
        )?;
        let snapshot = rows
            .pop()
            .map(|row| build_session(&transaction, &self.database, row))
            .transpose()?;
        transaction
            .commit()
            .map_err(|source| self.sqlite_error(source))?;
        Ok(snapshot)
    }

    fn sqlite_error(&self, source: rusqlite::Error) -> ConnectorError {
        ConnectorError::Sqlite {
            path: self.database.clone(),
            source,
        }
    }
}

impl SessionConnector for OpenCodeConnector {
    fn provider(&self) -> ExternalProvider {
        ExternalProvider::OpenCode
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn scan(&self) -> ConnectorScan {
        if !self.database.is_file() {
            return ConnectorScan::unavailable(self.provider(), self.root.clone());
        }
        match self.scan_database() {
            Ok(mut sessions) => {
                sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
                let message_count = sessions.iter().map(|session| session.message_count).sum();
                ConnectorScan {
                    status: ExternalProviderStatus {
                        provider: self.provider(),
                        root: self.root.to_string_lossy().into_owned(),
                        available: true,
                        session_count: sessions.len(),
                        message_count,
                        error: None,
                    },
                    sessions,
                    errors: Vec::new(),
                }
            }
            Err(error) => ConnectorScan {
                status: ExternalProviderStatus {
                    provider: self.provider(),
                    root: self.root.to_string_lossy().into_owned(),
                    available: true,
                    session_count: 0,
                    message_count: 0,
                    error: Some(error.to_string()),
                },
                sessions: Vec::new(),
                errors: vec![error],
            },
        }
    }

    fn load(
        &self,
        external_id: &str,
        source_path: &str,
    ) -> Result<Option<ExternalSessionSnapshot>, ConnectorError> {
        if self.database.to_string_lossy() != source_path {
            return Err(ConnectorError::InvalidData(
                "OpenCode database path changed after scanning".to_owned(),
            ));
        }
        self.load_database(external_id)
    }
}

fn database_path(root: &Path) -> PathBuf {
    match std::env::var_os("OPENCODE_DB") {
        Some(value) if Path::new(&value).is_absolute() => PathBuf::from(value),
        Some(value) => root.join(value),
        None => root.join("opencode.db"),
    }
}

fn validate_schema(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    for table in ["session", "message", "part"] {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    Ok(())
}

fn load_session_summaries(
    transaction: &Transaction<'_>,
    database: &Path,
) -> Result<Vec<ExternalSessionSummary>, ConnectorError> {
    let mut statement = transaction
        .prepare(
            "SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                    COALESCE(counts.message_count, 0)
             FROM session s
             LEFT JOIN (
               SELECT m.session_id, COUNT(DISTINCT m.id) AS message_count
               FROM message m
               JOIN part p ON p.message_id = m.id
               WHERE json_extract(p.data, '$.type') = 'text'
                 AND COALESCE(json_extract(p.data, '$.text'), '') <> ''
                 AND json_extract(m.data, '$.role') IN ('user', 'assistant')
               GROUP BY m.session_id
             ) counts ON counts.session_id = s.id
             ORDER BY s.time_updated DESC, s.id ASC",
        )
        .map_err(|source| ConnectorError::Sqlite {
            path: database.to_path_buf(),
            source,
        })?;
    let rows = statement
        .query_map([], |row| {
            let created_ms: i64 = row.get(3)?;
            let updated_ms: i64 = row.get(4)?;
            let message_count: i64 = row.get(5)?;
            let message_count = usize::try_from(message_count)
                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(5, message_count))?;
            Ok(ExternalSessionSummary {
                provider: ExternalProvider::OpenCode,
                external_id: row.get(0)?,
                cwd: row.get(1)?,
                title: row.get(2)?,
                source_path: database.to_string_lossy().into_owned(),
                message_count,
                created_at: timestamp_milliseconds(created_ms),
                updated_at: timestamp_milliseconds(updated_ms),
                continuation_mode: ExternalContinuationMode::RecreateOnly,
            })
        })
        .map_err(|source| ConnectorError::Sqlite {
            path: database.to_path_buf(),
            source,
        })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|source| ConnectorError::Sqlite {
            path: database.to_path_buf(),
            source,
        })
}

fn build_session(
    transaction: &Transaction<'_>,
    database: &Path,
    session_row: Value,
) -> Result<ExternalSessionSnapshot, ConnectorError> {
    let external_id = required_string(&session_row, "id", "OpenCode session")?;
    let title = required_string(&session_row, "title", &external_id)?;
    let cwd = optional_string(&session_row, "directory");
    let message_rows = query_json_rows(
        transaction,
        "SELECT * FROM message WHERE session_id = ?1 ORDER BY time_created ASC, id ASC",
        params![external_id],
        database,
    )?;
    let mut sequence = 0;
    let mut events = vec![event_from_row(
        "session",
        &external_id,
        sequence,
        session_row.clone(),
    )];
    let mut messages = Vec::new();
    for message_row in message_rows {
        sequence += 1;
        let message_id = required_string(&message_row, "id", "OpenCode message")?;
        let occurred_at = timestamp_field(&message_row, "time_created");
        let message_event = event_from_row("message", &message_id, sequence, message_row.clone());
        let event_id = message_event.event_id.clone();
        events.push(message_event);
        let (part_events, content) = load_parts(transaction, database, &message_id, &mut sequence)?;
        events.extend(part_events);
        if let Some(role) = message_role(&message_row)? {
            if let Some(content) = projected_content(ExternalProvider::OpenCode, role, content) {
                messages.push(ExternalSessionMessage {
                    event_id,
                    role,
                    content,
                    occurred_at,
                });
            }
        }
    }
    let (created_at, updated_at) = first_and_last_timestamp(&events);
    Ok(ExternalSessionSnapshot {
        summary: ExternalSessionSummary {
            provider: ExternalProvider::OpenCode,
            external_id,
            title,
            cwd,
            source_path: database.to_string_lossy().into_owned(),
            message_count: messages.len(),
            created_at: timestamp_field(&session_row, "time_created").or(created_at),
            updated_at: timestamp_field(&session_row, "time_updated").or(updated_at),
            continuation_mode: ExternalContinuationMode::RecreateOnly,
        },
        events,
        messages,
    })
}

fn load_parts(
    transaction: &Transaction<'_>,
    database: &Path,
    message_id: &str,
    sequence: &mut usize,
) -> Result<(Vec<ExternalSessionEvent>, String), ConnectorError> {
    let rows = query_json_rows(
        transaction,
        "SELECT * FROM part WHERE message_id = ?1 ORDER BY id ASC",
        params![message_id],
        database,
    )?;
    let mut events = Vec::new();
    let mut text_parts = Vec::new();
    for row in rows {
        *sequence += 1;
        let part_id = required_string(&row, "id", "OpenCode part")?;
        if let Some(text) = text_part(&row)? {
            text_parts.push(text);
        }
        events.push(event_from_row("part", &part_id, *sequence, row));
    }
    Ok((events, text_parts.join("\n")))
}

fn message_role(row: &Value) -> Result<Option<Role>, ConnectorError> {
    let data = parsed_data(row, "message")?;
    Ok(match data.get("role").and_then(Value::as_str) {
        Some("user") => Some(Role::User),
        Some("assistant") => Some(Role::Assistant),
        Some("system") => Some(Role::System),
        _ => None,
    })
}

fn text_part(row: &Value) -> Result<Option<String>, ConnectorError> {
    let data = parsed_data(row, "part")?;
    if data.get("type").and_then(Value::as_str) != Some("text") {
        return Ok(None);
    }
    Ok(data
        .get("text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

fn parsed_data(row: &Value, record: &str) -> Result<Value, ConnectorError> {
    let raw = row.get("data").and_then(Value::as_str).ok_or_else(|| {
        ConnectorError::InvalidData(format!("OpenCode {record} has no data JSON"))
    })?;
    serde_json::from_str(raw).map_err(|error| {
        ConnectorError::InvalidData(format!("invalid OpenCode {record} data: {error}"))
    })
}

fn event_from_row(record: &str, id: &str, sequence: usize, payload: Value) -> ExternalSessionEvent {
    ExternalSessionEvent {
        event_id: format!("{record}:{id}"),
        sequence,
        event_type: record.to_owned(),
        occurred_at: timestamp_field(&payload, "time_created"),
        payload,
    }
}

fn query_json_rows<P: rusqlite::Params>(
    transaction: &Transaction<'_>,
    sql: &str,
    params: P,
    database: &Path,
) -> Result<Vec<Value>, ConnectorError> {
    let mut statement = transaction
        .prepare(sql)
        .map_err(|source| ConnectorError::Sqlite {
            path: database.to_path_buf(),
            source,
        })?;
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let rows = statement
        .query_map(params, |row| json_row(row, &columns))
        .map_err(|source| ConnectorError::Sqlite {
            path: database.to_path_buf(),
            source,
        })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|source| ConnectorError::Sqlite {
            path: database.to_path_buf(),
            source,
        })
}

fn json_row(row: &Row<'_>, columns: &[String]) -> rusqlite::Result<Value> {
    let mut object = Map::new();
    for (index, name) in columns.iter().enumerate() {
        object.insert(name.clone(), sqlite_json(row.get_ref(index)?));
    }
    Ok(Value::Object(object))
}

fn sqlite_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Number(value.into()),
        ValueRef::Real(value) => Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Array(
            value
                .iter()
                .map(|byte| Value::Number((*byte).into()))
                .collect(),
        ),
    }
}

fn required_string(value: &Value, field: &str, label: &str) -> Result<String, ConnectorError> {
    optional_string(value, field)
        .ok_or_else(|| ConnectorError::InvalidData(format!("{label} has no {field}")))
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn timestamp_field(value: &Value, field: &str) -> Option<String> {
    let milliseconds = value.get(field)?.as_i64()?;
    timestamp_milliseconds(milliseconds)
}

fn timestamp_milliseconds(milliseconds: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(milliseconds) * 1_000_000)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_current_opencode_sqlite_shape() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("opencode.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
                 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
                 CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
                 INSERT INTO session VALUES ('s1', 'C:/work', 'OpenCode title', 1000, 3000);
                 INSERT INTO message VALUES ('m1', 's1', 2000, '{\"role\":\"user\"}');
                 INSERT INTO part VALUES ('p1', 'm1', 's1', 2000, '{\"type\":\"text\",\"text\":\"full prompt\"}');
                 INSERT INTO message VALUES ('m2', 's1', 2500, '{\"role\":\"system\"}');
                 INSERT INTO part VALUES ('p2', 'm2', 's1', 2500, '{\"type\":\"text\",\"text\":\"provider instructions\"}');",
            )
            .unwrap();
        drop(connection);

        let connector = OpenCodeConnector::new(temp.path().to_path_buf(), database);
        let scan = connector.scan();
        assert!(scan.errors.is_empty());
        assert_eq!(scan.sessions.len(), 1);
        assert_eq!(scan.sessions[0].external_id, "s1");
        assert_eq!(scan.sessions[0].message_count, 1);
        let loaded = connector
            .load("s1", &scan.sessions[0].source_path)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.messages[0].content, "full prompt");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.events.len(), 5);
    }
}
