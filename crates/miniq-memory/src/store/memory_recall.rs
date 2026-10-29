use super::{memories, memory_index, memory_policy, now_iso, Result, Store};
use miniq_protocol::MemoryRecord;
use rusqlite::params;
use std::collections::HashSet;

fn record_reads(conn: &rusqlite::Connection, session: &str, rows: &[MemoryRecord]) -> Result<()> {
    for row in rows {
        conn.execute("INSERT INTO memory_recalls(session_id,memory_id,revision,recalled_at) VALUES (?1,?2,?3,?4)
            ON CONFLICT(session_id,memory_id) DO UPDATE SET revision=excluded.revision,recalled_at=excluded.recalled_at",
            params![session,row.id,row.revision,now_iso()])?;
    }
    Ok(())
}

fn cost(value: &impl serde::Serialize) -> usize {
    serde_json::to_string(value)
        .unwrap()
        .chars()
        .map(|c| if c.is_ascii() { 1 } else { 3 })
        .sum::<usize>()
        .div_ceil(3)
}
impl Store {
    /// Bounded selection of whole facts. Oversized facts remain available to memory_read.
    pub fn recall_memories(&self, session: &str, query: &str) -> Result<Vec<MemoryRecord>> {
        let conn = self.conn.lock().unwrap();
        if !memory_policy::settings(&conn)?.recall_enabled
            || !memory_policy::session_enabled(&conn, session)?
        {
            return Ok(Vec::new());
        }
        let workspace: String = conn.query_row(
            "SELECT workspace_id FROM sessions WHERE id=?1",
            [session],
            |r| r.get(0),
        )?;
        let mut selected = Vec::new();
        let mut ids = HashSet::new();
        let mut used = 0;
        let mut stmt = conn.prepare(&format!("SELECT {} FROM memories m WHERE m.kind='preference'
            AND ((m.scope='global' AND m.workspace_id IS NULL) OR (m.scope='workspace' AND m.workspace_id=?1))
            ORDER BY (m.scope='workspace') DESC, m.updated_at DESC,m.id", memories::COLUMNS))?;
        for row in stmt.query_map([&workspace], memories::row)? {
            let row = row?;
            let size = cost(&row);
            if used + size > 300 {
                continue;
            }
            used += size;
            ids.insert(row.id.clone());
            selected.push(row);
        }
        if !query.trim().is_empty() {
            for row in memory_index::search(&conn, Some(&workspace), query, 50)? {
                let size = cost(&row);
                if !ids.contains(&row.id) && used + size <= 1000 {
                    used += size;
                    ids.insert(row.id.clone());
                    selected.push(row);
                }
            }
        }
        record_reads(&conn, session, &selected)?;
        Ok(selected)
    }
    pub fn record_memory_reads(&self, session: &str, rows: &[MemoryRecord]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        if !memory_policy::session_enabled(&conn, session)? {
            return Ok(());
        }
        let workspace: String = conn.query_row(
            "SELECT workspace_id FROM sessions WHERE id=?1",
            [session],
            |r| r.get(0),
        )?;
        for reference in rows {
            if let Some(row) = memories::get(&conn, &reference.id)? {
                if row.revision == reference.revision
                    && ((row.scope == "global" && row.workspace_id.is_none())
                        || (row.scope == "workspace"
                            && row.workspace_id.as_deref() == Some(&workspace)))
                {
                    record_reads(&conn, session, std::slice::from_ref(&row))?;
                }
            }
        }
        Ok(())
    }
    /// Revalidate references before each request, without repeating search.
    pub fn current_recalled_memories(
        &self,
        session: &str,
        selected: &[MemoryRecord],
    ) -> Result<Vec<MemoryRecord>> {
        let conn = self.conn.lock().unwrap();
        if !memory_policy::settings(&conn)?.recall_enabled
            || !memory_policy::session_enabled(&conn, session)?
        {
            return Ok(Vec::new());
        }
        let mut rows = Vec::new();
        for reference in selected {
            if let Some(current) = memories::get(&conn, &reference.id)? {
                if current.revision == reference.revision {
                    rows.push(current);
                }
            }
        }
        Ok(rows)
    }
    /// Read live goal status instead of freezing task state in a memory string.
    pub fn memory_project_goals(&self, session: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        if !memory_policy::session_enabled(&conn, session)?
            || !memory_policy::settings(&conn)?.recall_enabled
        {
            return Ok(Vec::new());
        }
        let mut stmt = conn.prepare("SELECT s.id,s.title,g.goal,g.status,s.updated_at FROM sessions s LEFT JOIN session_goals g ON s.id=g.session_id
            WHERE s.workspace_id=(SELECT workspace_id FROM sessions WHERE id=?1) AND s.id!=?1
            AND (g.session_id IS NOT NULL OR EXISTS(SELECT 1 FROM session_plans p WHERE p.session_id=s.id)
                OR EXISTS(SELECT 1 FROM memory_sources ms JOIN memories m ON m.id=ms.memory_id JOIN messages msg ON msg.id=ms.message_id
                    WHERE msg.session_id=s.id AND ms.revision=m.revision AND m.kind='project'))
            AND NOT EXISTS(SELECT 1 FROM memory_session_policy p WHERE p.session_id=s.id AND p.enabled=0)
            AND NOT EXISTS(SELECT 1 FROM session_forks f WHERE f.session_id=s.id AND f.mode='side')
            ORDER BY s.updated_at DESC,s.id")?;
        let mut result = Vec::new();
        let mut budget = 300;
        let mut rows = stmt.query([session])?;
        while let Some(row) = rows.next()? {
            let value = serde_json::json!({"sessionId":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,"goal":row.get::<_,Option<String>>(2)?,"status":row.get::<_,Option<String>>(3)?,"updatedAt":row.get::<_,String>(4)?,"readWith":"memory_project_read"});
            let size = cost(&value);
            if size <= budget {
                budget -= size;
                result.push(value);
            }
        }
        Ok(result)
    }
}
