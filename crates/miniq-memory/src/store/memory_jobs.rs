//! Persistent, leased source pages. Model calls happen outside the store lock.
use super::{
    memory_policy,
    memory_write::{self, hash},
    new_id, MemoryError, MemoryEvidence, Result, Store,
};
use miniq_protocol::{MemoryCandidate, MemoryTarget, MemoryWriteParams, MemoryWriteResult};
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone)]
pub struct MemoryJob {
    pub message_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub source_hash: String,
    pub content: String,
    pub cursor: usize,
    pub next_cursor: usize,
    pub finished: bool,
    pub generation: i64,
    pub lease: String,
}
pub(super) fn enqueue(conn: &Connection, session: &str, anchor: &str) -> Result<()> {
    if !memory_policy::settings(conn)?.auto_save || !memory_policy::session_enabled(conn, session)?
    {
        return Ok(());
    }
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM scheduled_task_runs WHERE session_id=?1 AND status='running')",
        [session],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    // Previous outcome (success or failure) is the lower boundary. Never turn a
    // previously failed/cancelled turn into evidence of completed work.
    let mut stmt = conn.prepare("SELECT m.id,m.content FROM messages m WHERE m.session_id=?1 AND m.role='user' AND m.inherited=0
        AND NOT EXISTS(SELECT 1 FROM session_forks f WHERE f.session_id=m.session_id AND m.created_at<=f.created_at)
        AND NOT EXISTS(SELECT 1 FROM external_session_links e WHERE e.session_id=m.session_id AND m.created_at<=e.last_synced_at)
        AND m.rowid > (SELECT source_boundary FROM memory_policy WHERE id=1)
        AND m.rowid > COALESCE((SELECT MAX(p.rowid) FROM audit_events a JOIN messages p ON p.id=json_extract(a.payload_json,'$.anchorMessageId')
          WHERE a.session_id=?1 AND a.event_type='turn_outcome'),0)
        AND m.rowid <= (SELECT rowid FROM messages WHERE id=?2)")?;
    for item in stmt.query_map(params![session, anchor], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (id, content) = item?;
        conn.execute("INSERT OR IGNORE INTO memory_jobs(message_id,source_hash,generation) SELECT ?1,?2,generation FROM memory_policy WHERE id=1", params![id, hash(&content)])?;
    }
    Ok(())
}
fn unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
impl Store {
    pub fn claim_memory_job(&self) -> Result<Option<MemoryJob>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !memory_policy::settings(&tx)?.auto_save {
            return Ok(None);
        }
        let raw = tx.query_row("SELECT j.message_id,m.session_id,s.workspace_id,j.source_hash,m.content,j.cursor
            FROM memory_jobs j JOIN messages m ON m.id=j.message_id JOIN sessions s ON s.id=m.session_id
            WHERE j.done=0 AND j.ready_at<=?1 AND j.lease_until<=?1
            AND NOT EXISTS(SELECT 1 FROM memory_session_policy p WHERE p.session_id=s.id AND p.enabled=0)
            AND NOT EXISTS(SELECT 1 FROM session_forks f WHERE f.session_id=s.id AND f.mode='side')
            ORDER BY j.ready_at,m.rowid LIMIT 1", [unix()], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?,r.get::<_, String>(3)?,r.get::<_, String>(4)?,r.get::<_, usize>(5)?))).optional()?;
        let Some((message_id, session_id, workspace_id, source_hash, source, cursor)) = raw else {
            return Ok(None);
        };
        if hash(&source) != source_hash || !source.is_char_boundary(cursor) {
            return Err(MemoryError::InvalidData(
                "source changed; cannot resume extraction".into(),
            ));
        }
        let next_cursor = source[cursor..]
            .char_indices()
            .nth(6000)
            .map_or(source.len(), |(i, _)| cursor + i);
        let generation =
            tx.query_row("SELECT generation FROM memory_policy WHERE id=1", [], |r| {
                r.get(0)
            })?;
        let lease = new_id("lease");
        tx.execute(
            "UPDATE memory_jobs SET lease=?2,lease_until=?3,generation=?4 WHERE message_id=?1",
            params![message_id, lease, unix() + 120, generation],
        )?;
        let job = MemoryJob {
            message_id,
            session_id,
            workspace_id,
            source_hash,
            content: source[cursor..next_cursor].into(),
            cursor,
            next_cursor,
            finished: next_cursor == source.len(),
            generation,
            lease,
        };
        tx.commit()?;
        Ok(Some(job))
    }
    pub fn commit_memory_job(
        &self,
        job: &MemoryJob,
        candidates: &[MemoryCandidate],
    ) -> Result<Vec<MemoryWriteResult>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_jobs j,memory_policy p WHERE j.message_id=?1 AND j.lease=?2 AND j.cursor=?3
            AND j.generation=?4 AND p.generation=?4 AND p.auto_save=1 AND j.lease_until>?5 AND j.extractor_version=1)",
            params![job.message_id, job.lease, job.cursor as i64, job.generation, unix()], |r| r.get(0))?;
        if !valid || !memory_policy::session_enabled(&tx, &job.session_id)? {
            return Err(MemoryError::InvalidData(
                "memory job lease or consent changed".into(),
            ));
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM session_approval_settings WHERE session_id=?1 AND mode='alwaysAsk')", [&job.session_id], |r|r.get::<_,bool>(0))? {
            return Err(MemoryError::InvalidData("session requires approval for memory writes".into()));
        }
        let mut evidence = MemoryEvidence {
            message_id: job.message_id.clone(),
            content_hash: job.source_hash.clone(),
            byte_start: job.cursor,
            byte_end: job.next_cursor,
        };
        let target = MemoryTarget::Workspace {
            workspace_id: job.workspace_id.clone(),
        };
        if !memory_write::evidence_valid(&tx, &evidence, &target)? {
            return Err(MemoryError::InvalidData("memory source changed".into()));
        }
        let mut results = Vec::new();
        for candidate in candidates {
            if candidate.evidence.trim().is_empty() || !job.content.contains(&candidate.evidence) {
                return Err(MemoryError::InvalidData(
                    "candidate must quote evidence from this source page".into(),
                ));
            }
            evidence.byte_start = job.cursor + job.content.find(&candidate.evidence).unwrap();
            evidence.byte_end = evidence.byte_start + candidate.evidence.len();
            results.push(memory_write::write(
                &tx,
                &MemoryWriteParams {
                    target: target.clone(),
                    content: candidate.content.clone(),
                    kind: candidate.kind,
                    key: Some(candidate.key.clone()),
                    replaces: None,
                },
                Some(&evidence),
                true,
            )?);
        }
        tx.execute("UPDATE memory_jobs SET cursor=?2,done=?3,lease=NULL,lease_until=0,attempts=0 WHERE message_id=?1", params![job.message_id, job.next_cursor as i64, job.finished])?;
        tx.commit()?;
        Ok(results)
    }
    pub fn retry_memory_job(&self, job: &MemoryJob) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE memory_jobs SET lease=NULL,lease_until=0,attempts=attempts+1,
            ready_at=?3+min(3600,30*(1<<min(attempts,7))) WHERE message_id=?1 AND lease=?2",
            params![job.message_id, job.lease, unix()],
        )?;
        Ok(())
    }
}
