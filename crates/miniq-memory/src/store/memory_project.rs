//! Project handoff is a view of authoritative state, not a second stale summary.
use super::{memories, memory_policy, now_iso, MemoryError, Result, Store};
use miniq_protocol::MemoryProjectSummary;
use rusqlite::params;

impl Store {
    pub fn memory_project_summary(
        &self,
        current_session: &str,
        source_session: &str,
    ) -> Result<MemoryProjectSummary> {
        let current = self.get_session(current_session)?;
        let source = self.get_session(source_session)?;
        if current.workspace_id != source.workspace_id
            || !self.session_memory_enabled(current_session)?
            || !self.session_memory_enabled(source_session)?
            || !self.memory_settings()?.recall_enabled
        {
            return Err(MemoryError::InvalidData(
                "project context is unavailable in this scope".into(),
            ));
        }
        let goal = self.session_goal(source_session)?;
        let plan = self.session_plan(source_session)?;
        let artifacts = self.list_artifacts(source_session)?;
        let last_turn_outcome = self.last_turn_outcome(source_session)?;
        let conn = self.conn.lock().unwrap();
        // Recheck policy after independent source reads; no model/network calls hold this lock.
        if !memory_policy::session_enabled(&conn, current_session)?
            || !memory_policy::session_enabled(&conn, source_session)?
            || !memory_policy::settings(&conn)?.recall_enabled
        {
            return Err(MemoryError::InvalidData(
                "project memory policy changed".into(),
            ));
        }
        let mut stmt=conn.prepare(&format!("SELECT {} FROM memories m WHERE m.scope='workspace' AND m.workspace_id=?1 AND m.kind='project'
            AND EXISTS(SELECT 1 FROM memory_sources s JOIN messages msg ON msg.id=s.message_id
                WHERE s.memory_id=m.id AND s.revision=m.revision AND msg.session_id=?2)
            ORDER BY m.updated_at DESC,m.id",memories::COLUMNS))?;
        let decisions = stmt
            .query_map(params![current.workspace_id, source_session], memories::row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(MemoryProjectSummary {
            session_id: source.id,
            session_status: source.status,
            title: source.title,
            goal,
            plan,
            decisions,
            artifacts,
            last_turn_outcome,
            observed_at: now_iso(),
        })
    }
}
