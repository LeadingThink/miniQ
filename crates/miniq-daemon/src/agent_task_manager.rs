//! Session-scoped delegated agents with durable checkpoints and lazy results.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use miniq_models::ChatMessage;
use miniq_tools::{AgentRunRequest, ToolError};
use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::agent_worktree::{self, AgentWorktree};

mod cancellation;
mod lifecycle;
mod persistence;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum AgentStatus {
    Running,
    Stopping,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl AgentStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Stopping | Self::Finalizing)
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRecordState {
    description: String,
    name: String,
    agent_type: String,
    model: Option<String>,
    status: AgentStatus,
    error: Option<String>,
    progress: Option<miniq_protocol::TurnProgress>,
    has_history: bool,
    model_identity: Option<String>,
    inbox: VecDeque<String>,
    held_messages: Vec<String>,
    #[serde(skip)]
    cancel: CancellationToken,
    request: AgentRunRequest,
    worktree: Option<AgentWorktree>,
    worktree_retained: bool,
    worktree_error: Option<String>,
    elapsed_ms: u64,
    completed_at: Option<String>,
    timing_complete: bool,
    #[serde(skip)]
    active_since: Option<Instant>,
}

pub(crate) struct AgentRecord {
    pub(crate) id: String,
    pub(crate) session_id: String,
    parent_id: Option<String>,
    created_at: String,
    state: Mutex<AgentRecordState>,
    changed: Notify,
}

pub(crate) struct AgentTaskManager {
    store: Arc<miniq_memory::Store>,
    records: Mutex<HashMap<String, Arc<AgentRecord>>>,
    names: Mutex<HashMap<(String, String), String>>,
    loaded_sessions: Mutex<HashSet<String>>,
}

pub(crate) enum MessageDisposition {
    Queued(Value),
    Resume(Box<AgentRunRequest>),
}

impl AgentTaskManager {
    pub(crate) async fn has_active(&self, session_id: &str) -> bool {
        let records = self.records.lock().await;
        for record in records
            .values()
            .filter(|record| record.session_id == session_id)
        {
            if record.state.lock().await.status.is_active() {
                return true;
            }
        }
        false
    }

    pub(crate) async fn list(&self, session_id: &str) -> Result<Vec<Value>, ToolError> {
        self.ensure_loaded(session_id).await?;
        let records = self
            .records
            .lock()
            .await
            .values()
            .filter(|record| record.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut entries = Vec::with_capacity(records.len());
        for record in records {
            entries.push(self.snapshot(&record.id, &record).await);
        }
        entries.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
        Ok(entries)
    }

    pub(crate) async fn create(
        &self,
        session_id: &str,
        parent_id: Option<&str>,
        request: &AgentRunRequest,
        cancel: CancellationToken,
    ) -> Result<(String, Arc<AgentRecord>), ToolError> {
        self.ensure_loaded(session_id).await?;
        let id = miniq_memory::new_id("agent");
        let name = request.name.clone().unwrap_or_else(|| id.clone());
        let mut names = self.names.lock().await;
        let scoped_name = (session_id.to_string(), name.clone());
        if names.contains_key(&scoped_name) {
            return Err(ToolError::InvalidInput(format!(
                "agent name is already in use: {name}"
            )));
        }
        let record = Arc::new(AgentRecord {
            id: id.clone(),
            session_id: session_id.to_string(),
            parent_id: parent_id.map(str::to_owned),
            created_at: miniq_memory::now_iso(),
            state: Mutex::new(AgentRecordState {
                description: request
                    .description
                    .clone()
                    .unwrap_or_else(|| "delegated task".into()),
                name,
                agent_type: request
                    .subagent_type
                    .clone()
                    .unwrap_or_else(|| "general-purpose".into()),
                model: request.model.clone(),
                status: AgentStatus::Running,
                error: None,
                progress: None,
                has_history: false,
                model_identity: None,
                inbox: VecDeque::new(),
                held_messages: Vec::new(),
                cancel,
                request: request.clone(),
                worktree: None,
                worktree_retained: false,
                worktree_error: None,
                elapsed_ms: 0,
                completed_at: None,
                timing_complete: true,
                active_since: Some(Instant::now()),
            }),
            changed: Notify::new(),
        });
        self.store
            .create_agent_task(&miniq_memory::AgentTaskRow {
                id: id.clone(),
                session_id: session_id.into(),
                name: scoped_name.1.clone(),
                parent_id: record.parent_id.clone(),
                created_at: record.created_at.clone(),
                state: serde_json::to_value(&*record.state.lock().await)
                    .map_err(persistence::storage_error)?,
            })
            .map_err(persistence::storage_error)?;
        names.insert(scoped_name, id.clone());
        self.records.lock().await.insert(id.clone(), record.clone());
        drop(names);
        Ok((id, record))
    }

    async fn resolve(
        &self,
        session_id: &str,
        id_or_name: &str,
    ) -> Result<(String, Arc<AgentRecord>), ToolError> {
        self.ensure_loaded(session_id).await?;
        let id = self
            .names
            .lock()
            .await
            .get(&(session_id.to_string(), id_or_name.to_string()))
            .cloned()
            .unwrap_or_else(|| id_or_name.to_string());
        let record = self
            .records
            .lock()
            .await
            .get(&id)
            .filter(|record| record.session_id == session_id)
            .cloned()
            .ok_or_else(|| ToolError::InvalidInput(format!("unknown agent: {id_or_name}")))?;
        Ok((id, record))
    }

    pub(crate) async fn prepare_resume(
        &self,
        session_id: &str,
        id_or_name: &str,
        request: &mut AgentRunRequest,
        cancel: CancellationToken,
    ) -> Result<(String, Arc<AgentRecord>, Vec<ChatMessage>), ToolError> {
        let (id, record) = self.resolve(session_id, id_or_name).await?;
        let mut guard = record.state.lock().await;
        let mut state = guard.clone();
        if state.status.is_active() {
            return Err(ToolError::InvalidInput(format!(
                "agent is already running: {id}"
            )));
        }
        inherit_request(request, &state.request);
        request.validate()?;
        let mut history: Vec<ChatMessage> = self
            .store
            .agent_history(session_id, &id)
            .map_err(persistence::storage_error)?
            .map(serde_json::from_value)
            .transpose()
            .map_err(persistence::storage_error)?
            .ok_or_else(|| ToolError::ExecutionFailed("agent has no resumable history".into()))?;
        if state.status == AgentStatus::Interrupted {
            history.push(ChatMessage::system(crate::turn_checkpoint::UNFINISHED_TURN));
        }
        state.status = AgentStatus::Running;
        state.error = None;
        state.progress = None;
        state.cancel = cancel;
        state.active_since = Some(Instant::now());
        state.completed_at = None;
        state.description = request
            .description
            .clone()
            .unwrap_or_else(|| "delegated task".into());
        state.agent_type = request
            .subagent_type
            .clone()
            .unwrap_or_else(|| "general-purpose".into());
        state.model = request.model.clone();
        state.request = request.clone();
        self.persist(&record, &state, None, Some(None))?;
        *guard = state;
        drop(guard);
        record.changed.notify_waiters();
        Ok((id, record, history))
    }

    pub(crate) async fn cancel_token(&self, record: &AgentRecord) -> CancellationToken {
        record.state.lock().await.cancel.clone()
    }

    pub(crate) async fn update_progress(
        &self,
        record: &AgentRecord,
        progress: miniq_protocol::TurnProgress,
    ) -> Result<(), ToolError> {
        let mut state = record.state.lock().await;
        state.progress = Some(progress);
        self.persist(record, &state, None, None)
    }

    pub(crate) async fn bind_model_context(
        &self,
        record: &AgentRecord,
        history: &mut [ChatMessage],
        identity: Option<String>,
    ) -> Result<(), ToolError> {
        let mut state = record.state.lock().await;
        crate::session_models::isolate_native_context(
            history,
            state.model_identity.as_deref(),
            identity.as_deref(),
        );
        state.model_identity = identity;
        self.persist(record, &state, None, None)
    }

    pub(crate) async fn worktree(&self, record: &AgentRecord) -> Option<AgentWorktree> {
        record.state.lock().await.worktree.clone()
    }

    pub(crate) async fn set_worktree(
        &self,
        record: &AgentRecord,
        worktree: AgentWorktree,
    ) -> Result<(), ToolError> {
        let mut state = record.state.lock().await;
        state.worktree = Some(worktree);
        state.worktree_retained = false;
        state.worktree_error = None;
        self.persist(record, &state, None, None)
    }

    pub(crate) async fn finalize_worktree(
        &self,
        record: &AgentRecord,
        worktree: Option<AgentWorktree>,
    ) -> Result<(), ToolError> {
        if let Some(worktree) = worktree {
            let outcome = agent_worktree::finalize(&worktree).await;
            let mut state = record.state.lock().await;
            state.worktree_retained = outcome.retained;
            state.worktree_error = outcome.error;
            state.worktree = outcome.retained.then_some(worktree);
            self.persist(record, &state, None, None)?;
        }
        record.changed.notify_waiters();
        Ok(())
    }

    pub(crate) async fn snapshot(&self, id: &str, record: &AgentRecord) -> Value {
        let state = record.state.lock().await;
        Self::snapshot_state(id, record, &state)
    }

    fn snapshot_state(id: &str, record: &AgentRecord, state: &AgentRecordState) -> Value {
        json!({
            "agentId": id,
            "sessionId": record.session_id,
            "parentId": record.parent_id,
            "createdAt": record.created_at,
            "taskId": id,
            "name": state.name,
            "description": state.description,
            "subagentType": state.agent_type,
            "model": state.model,
            "status": state.status.as_str(),
            "error": state.error,
            "progress": state.progress,
            "queuedMessages": state.inbox.len(),
            "heldMessagesCount": state.held_messages.len(),
            "resumable": state.has_history,
            "completedAt": state.completed_at,
            "elapsedMs": state.observed_elapsed_ms(),
            "timingComplete": state.timing_complete,
            "worktreePath": state.worktree.as_ref().map(|worktree| worktree.path.display().to_string()),
            "worktreeBranch": state.worktree.as_ref().map(|worktree| worktree.branch.clone()),
            "worktreeRetained": state.worktree_retained,
            "worktreeError": state.worktree_error,
        })
    }

    pub(crate) async fn output(
        &self,
        session_id: &str,
        id_or_name: &str,
        block: bool,
        timeout: Duration,
    ) -> Result<Value, ToolError> {
        let (id, record) = self.resolve(session_id, id_or_name).await?;
        if block {
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                let changed = record.changed.notified();
                if !record.state.lock().await.status.is_active() {
                    break;
                }
                if tokio::time::timeout_at(deadline, changed).await.is_err() {
                    break;
                }
            }
        }
        let state = record.state.lock().await;
        let mut snapshot = Self::snapshot_state(&id, &record, &state);
        snapshot["result"] = self
            .store
            .agent_result(session_id, &id)
            .map_err(persistence::storage_error)?
            .into();
        snapshot["heldMessages"] =
            serde_json::to_value(&state.held_messages).map_err(persistence::storage_error)?;
        Ok(snapshot)
    }

    pub(crate) async fn route_message(
        &self,
        session_id: &str,
        id_or_name: &str,
        message: String,
    ) -> Result<MessageDisposition, ToolError> {
        let (id, record) = self.resolve(session_id, id_or_name).await?;
        loop {
            let changed = record.changed.notified();
            let mut state = record.state.lock().await;
            if state.status == AgentStatus::Running {
                state.inbox.push_back(message);
                if let Err(error) = self.persist(&record, &state, None, None) {
                    state.inbox.pop_back();
                    return Err(error);
                }
                let queued = state.inbox.len();
                return Ok(MessageDisposition::Queued(
                    json!({"agentId": id, "status": "queued", "queuedMessages": queued}),
                ));
            }
            if matches!(
                state.status,
                AgentStatus::Stopping | AgentStatus::Finalizing
            ) {
                drop(state);
                changed.await;
                continue;
            }
            if !state.has_history {
                return Err(ToolError::ExecutionFailed(format!(
                    "agent has no resumable history: {id}"
                )));
            }
            let mut request = state.request.clone();
            request.prompt = message;
            request.resume = Some(id);
            request.name = None;
            request.run_in_background = true;
            return Ok(MessageDisposition::Resume(Box::new(request)));
        }
    }
}

fn inherit_request(request: &mut AgentRunRequest, previous: &AgentRunRequest) {
    request.description = request
        .description
        .take()
        .or_else(|| previous.description.clone());
    request.subagent_type = request
        .subagent_type
        .take()
        .or_else(|| previous.subagent_type.clone());
    request.model = request.model.take().or_else(|| previous.model.clone());
    request.max_turns = request.max_turns.or(previous.max_turns);
    request.mode = request.mode.take().or_else(|| previous.mode.clone());
    request.cwd = request.cwd.take().or_else(|| previous.cwd.clone());
    request.isolation = request
        .isolation
        .take()
        .or_else(|| previous.isolation.clone());
}
