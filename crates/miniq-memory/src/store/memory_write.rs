use super::{memories, memory_index, new_id, now_iso, MemoryError, MemoryRow, Result, Store};
use miniq_protocol::{MemoryTarget, MemoryWriteParams, MemoryWriteResult, MemoryWriteStatus};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct MemoryEvidence {
    pub message_id: String,
    pub content_hash: String,
    pub byte_start: usize,
    pub byte_end: usize,
}
pub(super) fn hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
pub(super) fn scope_key(target: &MemoryTarget) -> String {
    match target {
        MemoryTarget::Global {} => "global".into(),
        MemoryTarget::Workspace { workspace_id } => format!("workspace:{workspace_id}"),
    }
}
fn conflict(memory: Option<MemoryRow>, reason: &str) -> MemoryWriteResult {
    MemoryWriteResult {
        status: MemoryWriteStatus::NeedsConfirmation,
        memory,
        reason: Some(reason.into()),
    }
}
pub(super) fn evidence_valid(
    conn: &Connection,
    evidence: &MemoryEvidence,
    target: &MemoryTarget,
) -> Result<bool> {
    let source: Option<(String, String)> = conn.query_row(
        "SELECT m.content,s.workspace_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=?1 AND m.role='user' AND m.inherited=0
         AND NOT EXISTS(SELECT 1 FROM memory_session_policy p WHERE p.session_id=s.id AND p.enabled=0)
         AND NOT EXISTS(SELECT 1 FROM session_forks f WHERE f.session_id=s.id AND f.mode='side')",
        [&evidence.message_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    Ok(source.is_some_and(|(content, workspace)| {
        hash(&content) == evidence.content_hash
            && target.parts().1.is_none_or(|w| w == workspace)
            && evidence.byte_start <= evidence.byte_end
            && content
                .get(evidence.byte_start..evidence.byte_end)
                .is_some()
    }))
}
fn attach(conn: &Connection, row: &MemoryRow, evidence: Option<&MemoryEvidence>) -> Result<()> {
    if let Some(e) = evidence {
        conn.execute("INSERT OR IGNORE INTO memory_sources(memory_id,revision,message_id,content_hash,byte_start,byte_end) VALUES (?1,?2,?3,?4,?5,?6)",
            params![row.id, row.revision, e.message_id, e.content_hash, e.byte_start as i64, e.byte_end as i64])?;
    }
    Ok(())
}
pub(super) fn invalidate(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM model_context_snapshots WHERE session_id IN (SELECT session_id FROM memory_recalls WHERE memory_id=?1)", [id])?;
    conn.execute(
        "UPDATE memory_policy SET generation=generation+1 WHERE id=1",
        [],
    )?;
    Ok(())
}
pub(super) fn excluded(
    conn: &Connection,
    input: &MemoryWriteParams,
    evidence: &MemoryEvidence,
) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM memory_exclusions WHERE scope_key IN (?1,'global') AND
        ((kind='source' AND value=?2) OR (kind='content' AND value=?3) OR (kind='key' AND value=?4)))",
        params![scope_key(&input.target), evidence.message_id, hash(input.content.trim()), input.key.as_deref().map(hash)], |r| r.get(0))?)
}
pub(super) fn write(
    conn: &Connection,
    input: &MemoryWriteParams,
    evidence: Option<&MemoryEvidence>,
    automatic: bool,
) -> Result<MemoryWriteResult> {
    memories::validate_target(conn, &input.target)?;
    if input.content.trim().is_empty() || input.key.as_ref().is_some_and(|k| k.trim().is_empty()) {
        return Err(MemoryError::InvalidData(
            "memory content/key must not be empty".into(),
        ));
    }
    if let Some(e) = evidence {
        if !evidence_valid(conn, e, &input.target)? {
            return Err(MemoryError::InvalidData(
                "memory source changed or is outside this workspace".into(),
            ));
        }
        if automatic && excluded(conn, input, e)? {
            return Ok(conflict(None, "source or fact was forgotten"));
        }
    } else if automatic {
        return Err(MemoryError::InvalidData(
            "automatic memory requires evidence".into(),
        ));
    }
    if automatic && (input.replaces.is_some() || matches!(input.target, MemoryTarget::Global {})) {
        return Err(MemoryError::InvalidData(
            "automatic extraction cannot overwrite facts or expand to global scope".into(),
        ));
    }
    let (scope, workspace) = input.target.parts();
    let old = if let Some(replacement) = &input.replaces {
        let old = memories::get(conn, &replacement.id)?
            .filter(|m| m.scope == scope && m.workspace_id.as_deref() == workspace);
        if old
            .as_ref()
            .is_none_or(|m| m.revision != replacement.expected_revision)
        {
            return Ok(conflict(
                old,
                "fact changed; read its current revision before correcting",
            ));
        }
        old
    } else {
        None
    };
    let duplicate = conn.query_row(&format!("SELECT {} FROM memories m WHERE m.scope=?1 AND m.workspace_id IS ?2 AND m.content=?3 AND m.fact_key IS ?4 ORDER BY m.updated_at DESC LIMIT 1", memories::COLUMNS),
        params![scope, workspace, input.content, input.key], memories::row).optional()?;
    if let Some(duplicate) = duplicate {
        if old.as_ref().is_some_and(|m| m.id != duplicate.id) {
            return Ok(conflict(
                Some(duplicate),
                "correction duplicates another logical fact; confirm which fact to retain",
            ));
        }
        if old.is_none() || (duplicate.kind == input.kind && duplicate.key == input.key) {
            attach(conn, &duplicate, evidence)?;
            return Ok(MemoryWriteResult {
                status: MemoryWriteStatus::Unchanged,
                memory: Some(duplicate),
                reason: None,
            });
        }
    }
    if let Some(key) = &input.key {
        let occupied = conn.query_row(&format!("SELECT {} FROM memories m WHERE m.scope=?1 AND m.workspace_id IS ?2 AND m.fact_key=?3 AND m.id IS NOT ?4 LIMIT 1", memories::COLUMNS),
            params![scope, workspace, key, old.as_ref().map(|m| &m.id)], memories::row).optional()?;
        if occupied.is_some() {
            return Ok(conflict(
                occupied,
                "same subject/attribute already has a fact; explicit correction is required",
            ));
        }
    }
    persist(conn, input, evidence, automatic, old)
}
fn persist(
    conn: &Connection,
    input: &MemoryWriteParams,
    evidence: Option<&MemoryEvidence>,
    automatic: bool,
    old: Option<MemoryRow>,
) -> Result<MemoryWriteResult> {
    let (scope, workspace) = input.target.parts();
    let now = now_iso();
    let kind = serde_json::to_value(input.kind)?
        .as_str()
        .unwrap()
        .to_owned();
    let row = MemoryRow {
        id: old.as_ref().map_or_else(|| new_id("mem"), |m| m.id.clone()),
        workspace_id: workspace.map(str::to_owned),
        scope: scope.into(),
        content: input.content.clone(),
        kind: input.kind,
        key: input.key.clone(),
        revision: old.as_ref().map_or(1, |m| m.revision + 1),
        origin: if automatic { "extracted" } else { "explicit" }.into(),
        created_at: old
            .as_ref()
            .map_or_else(|| now.clone(), |m| m.created_at.clone()),
        updated_at: now,
    };
    if old.is_some() {
        invalidate(conn, &row.id)?;
    }
    conn.execute("INSERT INTO memories(id,workspace_id,scope,content,metadata_json,created_at,updated_at,revision,kind,fact_key,origin)
        VALUES (?1,?2,?3,?4,'{}',?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET content=excluded.content,
        updated_at=excluded.updated_at,revision=excluded.revision,kind=excluded.kind,fact_key=excluded.fact_key,origin=excluded.origin",
        params![row.id, row.workspace_id, row.scope, row.content, row.created_at, row.updated_at, row.revision, kind, row.key, row.origin])?;
    conn.execute("INSERT INTO memory_versions(memory_id,revision,content,kind,fact_key,origin,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![row.id, row.revision, row.content, kind, row.key, row.origin, row.updated_at])?;
    attach(conn, &row, evidence)?;
    memory_index::index(conn, &row.id, &row.content)?;
    Ok(MemoryWriteResult {
        status: if old.is_some() {
            MemoryWriteStatus::Updated
        } else {
            MemoryWriteStatus::Added
        },
        memory: Some(row),
        reason: None,
    })
}
pub(super) fn forget(conn: &Connection, row: &MemoryRow) -> Result<()> {
    let target = row
        .workspace_id
        .as_ref()
        .map_or(MemoryTarget::Global {}, |id| MemoryTarget::Workspace {
            workspace_id: id.clone(),
        });
    let scope = scope_key(&target);
    conn.execute("INSERT OR IGNORE INTO memory_exclusions(scope_key,kind,value) SELECT ?1,'source',message_id FROM memory_sources WHERE memory_id=?2", params![scope, row.id])?;
    let mut stmt =
        conn.prepare("SELECT content,fact_key FROM memory_versions WHERE memory_id=?1")?;
    let mut versions = stmt.query([&row.id])?;
    while let Some(version) = versions.next()? {
        conn.execute(
            "INSERT OR IGNORE INTO memory_exclusions VALUES (?1,'content',?2)",
            params![scope, hash(version.get::<_, String>(0)?.trim())],
        )?;
        if let Some(key) = version.get::<_, Option<String>>(1)? {
            conn.execute(
                "INSERT OR IGNORE INTO memory_exclusions VALUES (?1,'key',?2)",
                params![scope, hash(&key)],
            )?;
        }
    }
    conn.execute("DELETE FROM memories WHERE id=?1", [&row.id])?;
    Ok(())
}
impl Store {
    pub fn memory_evidence(&self, message_id: &str) -> Result<MemoryEvidence> {
        let conn = self.conn.lock().unwrap();
        let content: String = conn.query_row(
            "SELECT content FROM messages WHERE id=?1 AND role='user'",
            [message_id],
            |r| r.get(0),
        )?;
        Ok(MemoryEvidence {
            message_id: message_id.into(),
            content_hash: hash(&content),
            byte_start: 0,
            byte_end: content.len(),
        })
    }
    pub fn write_memory(
        &self,
        input: &MemoryWriteParams,
        evidence: Option<&MemoryEvidence>,
    ) -> Result<MemoryWriteResult> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let result = write(&tx, input, evidence, false)?;
        tx.commit()?;
        Ok(result)
    }
}
