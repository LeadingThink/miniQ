use super::{MemoryError, Result, Store};
use miniq_protocol::{MemorySettings, SessionMemorySettings};
use rusqlite::{params, Connection};

pub(super) fn session_enabled(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.id=?1
        AND NOT EXISTS(SELECT 1 FROM session_forks f WHERE f.session_id=s.id AND f.mode='side')
        AND NOT EXISTS(SELECT 1 FROM memory_session_policy p WHERE p.session_id=s.id AND p.enabled=0))", [id], |r| r.get(0))?)
}
pub(super) fn settings(conn: &Connection) -> Result<MemorySettings> {
    Ok(conn.query_row(
        "SELECT recall_enabled,auto_save FROM memory_policy WHERE id=1",
        [],
        |r| {
            Ok(MemorySettings {
                recall_enabled: r.get(0)?,
                auto_save: r.get(1)?,
            })
        },
    )?)
}
impl Store {
    pub fn memory_settings(&self) -> Result<MemorySettings> {
        settings(&self.conn.lock().unwrap())
    }
    pub fn memory_generation(&self) -> Result<i64> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT generation FROM memory_policy WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn session_memory_enabled(&self, session_id: &str) -> Result<bool> {
        session_enabled(&self.conn.lock().unwrap(), session_id)
    }
    pub fn update_memory_settings(&self, value: &MemorySettings) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let previous = settings(&tx)?;
        if previous == *value {
            return Ok(());
        }
        tx.execute("UPDATE memory_policy SET recall_enabled=?1,auto_save=?2,generation=generation+1,
            source_boundary=CASE WHEN auto_save!=?2 THEN COALESCE((SELECT MAX(rowid) FROM messages),0) ELSE source_boundary END WHERE id=1", params![value.recall_enabled, value.auto_save])?;
        // New consent applies to future messages only; a disable/re-enable cannot replay a backlog.
        if previous.auto_save != value.auto_save {
            tx.execute("DELETE FROM memory_jobs WHERE done=0", [])?;
        }
        tx.execute("DELETE FROM model_context_snapshots WHERE session_id IN (SELECT session_id FROM memory_recalls)", [])?;
        tx.commit()?;
        Ok(())
    }
    pub fn update_session_memory_settings(&self, value: &SessionMemorySettings) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
            [&value.session_id],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(MemoryError::NotFound("session".into()));
        }
        tx.execute("INSERT INTO memory_session_policy(session_id,enabled) VALUES (?1,?2) ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled", params![value.session_id, value.enabled])?;
        tx.execute("DELETE FROM memory_jobs WHERE message_id IN (SELECT id FROM messages WHERE session_id=?1) AND done=0", [&value.session_id])?;
        tx.execute(
            "UPDATE memory_policy SET generation=generation+1 WHERE id=1",
            [],
        )?;
        tx.execute(
            "DELETE FROM model_context_snapshots WHERE session_id=?1",
            [&value.session_id],
        )?;
        tx.commit()?;
        Ok(())
    }
}
