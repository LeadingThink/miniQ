//! Durable undo history. A redo is valid only while the conversation still
//! matches the exact state left by undo, including its queue and tool records.
use super::{MemoryError, Result, Store};
use rusqlite::{
    params,
    types::{Value as SqlValue, ValueRef},
    Connection, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// Ordered so parent tool rows are restored before approvals/checkpoints.
const TABLES: &[&str] = &[
    "messages",
    "tool_calls",
    "approvals",
    "checkpoints",
    "artifacts",
    "model_context_snapshots",
    "session_plans",
    "turn_plans",
    "queued_messages",
    "audit_events",
];

#[derive(Serialize, Deserialize, PartialEq)]
enum Cell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Cell {
    fn sql(&self) -> SqlValue {
        match self {
            Self::Null => SqlValue::Null,
            Self::Integer(v) => SqlValue::Integer(*v),
            Self::Real(v) => SqlValue::Real(*v),
            Self::Text(v) => SqlValue::Text(v.clone()),
            Self::Blob(v) => SqlValue::Blob(v.clone()),
        }
    }
}

#[derive(Serialize, Deserialize, PartialEq)]
pub(super) struct Snapshot(Vec<Table>);

#[derive(Serialize, Deserialize, PartialEq)]
struct Table {
    name: String,
    columns: Vec<String>,
    rows: Vec<Vec<Cell>>,
}

fn condition(table: &str) -> &'static str {
    if table == "audit_events" {
        "session_id = ?1 AND event_type IN ('turn_timing', 'turn_outcome')"
    } else {
        "session_id = ?1"
    }
}

pub(super) fn capture(conn: &Connection, session: &str) -> Result<Snapshot> {
    let mut tables = Vec::new();
    for name in TABLES {
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM {name} WHERE {} ORDER BY rowid",
            condition(name)
        ))?;
        let columns: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|name| (*name).into())
            .collect();
        let rows = stmt
            .query_map([session], |row| {
                (0..columns.len())
                    .map(|index| {
                        Ok(match row.get_ref(index)? {
                            ValueRef::Null => Cell::Null,
                            ValueRef::Integer(v) => Cell::Integer(v),
                            ValueRef::Real(v) => Cell::Real(v),
                            ValueRef::Text(v) => {
                                Cell::Text(String::from_utf8_lossy(v).into_owned())
                            }
                            ValueRef::Blob(v) => Cell::Blob(v.to_vec()),
                        })
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        tables.push(Table {
            name: (*name).into(),
            columns,
            rows,
        });
    }
    Ok(Snapshot(tables))
}

pub(super) fn record(
    conn: &Connection,
    session: &str,
    previous: Snapshot,
    ready: bool,
) -> Result<()> {
    let expected = capture(conn, session)?;
    conn.execute("INSERT INTO session_redo (session_id, previous_json, expected_json, ready) VALUES (?1, ?2, ?3, ?4)",
        params![session, serde_json::to_string(&previous)?, serde_json::to_string(&expected)?, ready])?;
    Ok(())
}

impl Store {
    /// Finalize the file manifest only after rollback finishes, including partial failures.
    pub fn finish_undo_files(&self, session: &str, files: &Value) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE session_redo SET files_json = ?2, ready = 1
            WHERE id = (SELECT MAX(id) FROM session_redo WHERE session_id = ?1)",
            params![session, files.to_string()],
        )?;
        Ok(())
    }

    pub fn redo_candidate(&self, session: &str) -> Result<(i64, Value)> {
        let conn = self.conn.lock().unwrap();
        let (id, expected, files, ready): (i64, String, Option<String>, bool) = conn.query_row(
            "SELECT id, expected_json, files_json, ready FROM session_redo WHERE session_id = ?1 ORDER BY id DESC LIMIT 1",
            [session], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?
            .ok_or_else(|| MemoryError::InvalidData("nothing to redo".into()))?;
        if !ready {
            return Err(MemoryError::InvalidData(
                "undo file recovery is incomplete; redo is unavailable".into(),
            ));
        }
        verify(&conn, session, &expected)?;
        Ok((
            id,
            files
                .map(|text| serde_json::from_str(&text))
                .transpose()?
                .unwrap_or(Value::Null),
        ))
    }

    pub fn restore_redo(&self, session: &str, id: i64) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let (previous, expected): (String, String) = tx.query_row(
            "SELECT previous_json, expected_json FROM session_redo WHERE id = ?1 AND session_id = ?2 AND ready = 1",
            params![id, session], |row| Ok((row.get(0)?, row.get(1)?)))?;
        verify(&tx, session, &expected)?;
        let snapshot: Snapshot = serde_json::from_str(&previous)?;
        for name in TABLES.iter().rev() {
            tx.execute(
                &format!("DELETE FROM {name} WHERE {}", condition(name)),
                [session],
            )?;
        }
        for table in snapshot.0 {
            // Table and columns originate in this database, but validate the stored manifest before SQL interpolation.
            if !TABLES.contains(&table.name.as_str())
                || table
                    .columns
                    .iter()
                    .any(|name| !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            {
                return Err(MemoryError::InvalidData("invalid redo manifest".into()));
            }
            let placeholders = vec!["?"; table.columns.len()].join(",");
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({placeholders})",
                table.name,
                table.columns.join(",")
            );
            for row in table.rows {
                tx.execute(&sql, rusqlite::params_from_iter(row.iter().map(Cell::sql)))?;
            }
        }
        tx.execute(
            "DELETE FROM session_redo WHERE id = ?1 AND session_id = ?2",
            params![id, session],
        )?;
        tx.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![session, super::now_iso()],
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn verify(conn: &Connection, session: &str, expected: &str) -> Result<()> {
    if capture(conn, session)? != serde_json::from_str::<Snapshot>(expected)? {
        return Err(MemoryError::InvalidData(
            "conversation changed after undo; redo would overwrite new work".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "redo_tests.rs"]
mod tests;
