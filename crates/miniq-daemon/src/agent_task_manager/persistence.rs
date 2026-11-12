use super::*;

pub(super) fn storage_error(error: impl std::fmt::Display) -> ToolError {
    ToolError::ExecutionFailed(format!("agent persistence failed: {error}"))
}

fn metadata(state: &AgentRecordState) -> Result<Value, ToolError> {
    let mut metadata = serde_json::to_value(state).map_err(storage_error)?;
    metadata["elapsedMs"] = state.observed_elapsed_ms().into();
    Ok(metadata)
}

fn history_value(mut history: Vec<ChatMessage>) -> Result<Value, ToolError> {
    crate::security::redact_provider_history(&mut history);
    miniq_models::strip_memory_payloads(&mut history);
    serde_json::to_value(history).map_err(storage_error)
}

impl AgentRecordState {
    pub(super) fn observed_elapsed_ms(&self) -> u64 {
        self.elapsed_ms
            .saturating_add(self.active_since.map_or(0, |start| {
                u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
            }))
    }

    pub(super) fn finish_timing(&mut self) {
        self.elapsed_ms = self.observed_elapsed_ms();
        self.active_since = None;
        self.completed_at = Some(miniq_memory::now_iso());
    }
}

impl AgentTaskManager {
    pub(crate) fn new(store: Arc<miniq_memory::Store>) -> Self {
        Self {
            store,
            records: Mutex::new(HashMap::new()),
            names: Mutex::new(HashMap::new()),
            loaded_sessions: Mutex::new(HashSet::new()),
            admission: Mutex::new(()),
        }
    }

    pub(super) async fn ensure_loaded(&self, session_id: &str) -> Result<(), ToolError> {
        let mut loaded = self.loaded_sessions.lock().await;
        if loaded.contains(session_id) {
            return Ok(());
        }
        let rows = self
            .store
            .list_agent_tasks(session_id)
            .map_err(storage_error)?;
        let restored = rows
            .into_iter()
            .map(|row| {
                let state = serde_json::from_value(row.state).map_err(storage_error)?;
                Ok((
                    row.name,
                    Arc::new(AgentRecord {
                        id: row.id,
                        session_id: row.session_id,
                        parent_id: row.parent_id,
                        created_at: row.created_at,
                        state: Mutex::new(state),
                        changed: Notify::new(),
                    }),
                ))
            })
            .collect::<Result<Vec<_>, ToolError>>()?;
        let mut names = self.names.lock().await;
        let mut records = self.records.lock().await;
        for (name, record) in restored {
            names.insert((session_id.into(), name), record.id.clone());
            records.insert(record.id.clone(), record);
        }
        loaded.insert(session_id.into());
        Ok(())
    }

    pub(super) fn persist(
        &self,
        record: &AgentRecord,
        state: &AgentRecordState,
        history: Option<&[ChatMessage]>,
        result: Option<Option<&str>>,
    ) -> Result<(), ToolError> {
        let metadata = metadata(state)?;
        let history = history
            .map(|history| history_value(history.to_vec()))
            .transpose()?;
        self.store
            .save_agent_task(
                &record.session_id,
                &record.id,
                &metadata,
                history.as_ref(),
                result,
            )
            .map_err(storage_error)
    }

    pub(crate) async fn save_history(
        &self,
        record: &Arc<AgentRecord>,
        history: Vec<ChatMessage>,
    ) -> Result<(), ToolError> {
        let store = self.store.clone();
        let record = record.clone();
        // Own this transaction and the record lock even if its caller is
        // cancelled. A late save cannot overwrite a newer agent transition.
        tokio::spawn(async move {
            let mut guard = record.state.lock().await;
            let mut state = guard.clone();
            state.has_history = true;
            let metadata = metadata(&state)?;
            let session_id = record.session_id.clone();
            let id = record.id.clone();
            tokio::task::spawn_blocking(move || {
                let history = history_value(history)?;
                store
                    .save_agent_task(&session_id, &id, &metadata, Some(&history), None)
                    .map_err(storage_error)
            })
            .await
            .map_err(storage_error)??;
            *guard = state;
            Ok(())
        })
        .await
        .map_err(storage_error)?
    }
}
