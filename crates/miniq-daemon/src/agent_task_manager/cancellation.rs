//! Cancellation covers a whole agent subtree, including background work.

use std::collections::HashSet;

use super::*;

impl AgentTaskManager {
    pub(crate) async fn cancel_session(&self, session_id: &str) -> usize {
        self.cancel_matching(Some(session_id)).await
    }

    pub(crate) async fn cancel_all(&self) -> usize {
        self.cancel_matching(None).await
    }

    async fn cancel_matching(&self, session_id: Option<&str>) -> usize {
        let records = self
            .records
            .lock()
            .await
            .values()
            .filter(|record| session_id.is_none_or(|id| record.session_id == id))
            .cloned()
            .collect::<Vec<_>>();
        let mut cancelled = 0;
        for record in records {
            cancelled += usize::from(request_stop(&record).await);
        }
        cancelled
    }

    pub(crate) async fn stop(
        &self,
        session_id: &str,
        id_or_name: &str,
    ) -> Result<Value, ToolError> {
        let (id, record) = self.resolve(session_id, id_or_name).await?;
        let records = self
            .records
            .lock()
            .await
            .values()
            .filter(|record| record.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut subtree = HashSet::from([id.clone()]);
        loop {
            let before = subtree.len();
            for child in &records {
                if child
                    .parent_id
                    .as_ref()
                    .is_some_and(|id| subtree.contains(id))
                {
                    subtree.insert(child.id.clone());
                }
            }
            if subtree.len() == before {
                break;
            }
        }
        let descendants = records
            .into_iter()
            .filter(|record| subtree.contains(&record.id))
            .collect::<Vec<_>>();
        // Signal everyone before waiting, so one slow cleanup cannot delay others.
        for child in &descendants {
            request_stop(child).await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        for child in descendants {
            loop {
                let changed = child.changed.notified();
                if !child.state.lock().await.status.is_active() {
                    break;
                }
                if tokio::time::timeout_at(deadline, changed).await.is_err() {
                    break;
                }
            }
        }
        Ok(self.snapshot(&id, &record).await)
    }
}

async fn request_stop(record: &AgentRecord) -> bool {
    let mut state = record.state.lock().await;
    // Completed parents can still own background descendants.
    state.cancel.cancel();
    state.inbox.clear();
    let active = state.status.is_active();
    if matches!(state.status, AgentStatus::Running | AgentStatus::Finalizing) {
        state.status = AgentStatus::Stopping;
        state.error = Some("agent stopped by caller".into());
    }
    drop(state);
    record.changed.notify_waiters();
    active
}
