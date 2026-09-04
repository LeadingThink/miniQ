//! In-memory state and lifecycle transitions for delegated agents.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use miniq_agent::AgentError;
use miniq_models::ChatMessage;
use miniq_tools::{AgentRunRequest, ToolError};
use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::agent_worktree::{self, AgentWorktree};

#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentStatus {
    Running,
    Stopping,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
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
        }
    }

    fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Stopping | Self::Finalizing)
    }
}

struct AgentRecordState {
    description: String,
    name: String,
    agent_type: String,
    model: Option<String>,
    status: AgentStatus,
    result: Option<String>,
    error: Option<String>,
    history: Option<Vec<ChatMessage>>,
    inbox: VecDeque<String>,
    cancel: CancellationToken,
    request: AgentRunRequest,
    worktree: Option<AgentWorktree>,
    worktree_retained: bool,
    worktree_error: Option<String>,
}

pub(crate) struct AgentRecord {
    state: Mutex<AgentRecordState>,
    changed: Notify,
}

#[derive(Default)]
pub(crate) struct AgentTaskManager {
    records: Mutex<HashMap<String, Arc<AgentRecord>>>,
    names: Mutex<HashMap<String, String>>,
}

pub(crate) enum MessageDisposition {
    Queued(Value),
    Resume(Box<AgentRunRequest>),
}

impl AgentTaskManager {
    pub(crate) async fn create(
        &self,
        request: &AgentRunRequest,
        cancel: CancellationToken,
    ) -> Result<(String, Arc<AgentRecord>), ToolError> {
        let id = miniq_memory::new_id("agent");
        let name = request.name.clone().unwrap_or_else(|| id.clone());
        let mut names = self.names.lock().await;
        if names.contains_key(&name) {
            return Err(ToolError::InvalidInput(format!(
                "agent name is already in use: {name}"
            )));
        }
        names.insert(name.clone(), id.clone());
        drop(names);
        let record = Arc::new(AgentRecord {
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
                result: None,
                error: None,
                history: None,
                inbox: VecDeque::new(),
                cancel,
                request: request.clone(),
                worktree: None,
                worktree_retained: false,
                worktree_error: None,
            }),
            changed: Notify::new(),
        });
        self.records.lock().await.insert(id.clone(), record.clone());
        Ok((id, record))
    }

    async fn resolve(&self, id_or_name: &str) -> Result<(String, Arc<AgentRecord>), ToolError> {
        let id = self
            .names
            .lock()
            .await
            .get(id_or_name)
            .cloned()
            .unwrap_or_else(|| id_or_name.to_string());
        let record = self
            .records
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| ToolError::InvalidInput(format!("unknown agent: {id_or_name}")))?;
        Ok((id, record))
    }

    pub(crate) async fn prepare_resume(
        &self,
        id_or_name: &str,
        request: &mut AgentRunRequest,
        cancel: CancellationToken,
    ) -> Result<(String, Arc<AgentRecord>, Vec<ChatMessage>), ToolError> {
        let (id, record) = self.resolve(id_or_name).await?;
        let mut state = record.state.lock().await;
        if state.status.is_active() {
            return Err(ToolError::InvalidInput(format!(
                "agent is already running: {id}"
            )));
        }
        inherit_request(request, &state.request);
        request.validate()?;
        let history = state
            .history
            .clone()
            .ok_or_else(|| ToolError::ExecutionFailed("agent has no resumable history".into()))?;
        state.status = AgentStatus::Running;
        state.result = None;
        state.error = None;
        state.cancel = cancel;
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
        drop(state);
        record.changed.notify_waiters();
        Ok((id, record, history))
    }

    pub(crate) async fn finish_turn(
        &self,
        record: &AgentRecord,
        result: String,
        history: Vec<ChatMessage>,
    ) -> Option<(String, Vec<ChatMessage>)> {
        let mut state = record.state.lock().await;
        state.result = Some(result);
        state.history = Some(history.clone());
        if let Some(message) = state.inbox.pop_front() {
            return Some((message, history));
        }
        state.status = AgentStatus::Finalizing;
        None
    }

    pub(crate) async fn complete(&self, record: &AgentRecord) {
        let mut state = record.state.lock().await;
        if state.status == AgentStatus::Finalizing {
            state.status = AgentStatus::Completed;
        }
        drop(state);
        record.changed.notify_waiters();
    }

    pub(crate) async fn finish_error(&self, record: &AgentRecord, error: &AgentError) {
        let mut state = record.state.lock().await;
        let caller_stopped = state.status == AgentStatus::Stopping;
        state.status = if matches!(error, AgentError::Cancelled) {
            AgentStatus::Cancelled
        } else {
            AgentStatus::Failed
        };
        if !caller_stopped {
            state.error = Some(error.to_string());
        }
        drop(state);
        record.changed.notify_waiters();
    }

    pub(crate) async fn fail_start(&self, record: &AgentRecord, error: &ToolError) {
        let mut state = record.state.lock().await;
        state.status = AgentStatus::Failed;
        state.error = Some(error.to_string());
        drop(state);
        record.changed.notify_waiters();
    }

    pub(crate) async fn discard(&self, id: &str, record: &AgentRecord) {
        let name = record.state.lock().await.name.clone();
        self.records.lock().await.remove(id);
        self.names.lock().await.remove(&name);
    }

    pub(crate) async fn cancel_token(&self, record: &AgentRecord) -> CancellationToken {
        record.state.lock().await.cancel.clone()
    }

    pub(crate) async fn save_history(&self, record: &AgentRecord, history: &[ChatMessage]) {
        record.state.lock().await.history = Some(history.to_vec());
    }

    pub(crate) async fn worktree(&self, record: &AgentRecord) -> Option<AgentWorktree> {
        record.state.lock().await.worktree.clone()
    }

    pub(crate) async fn set_worktree(&self, record: &AgentRecord, worktree: AgentWorktree) {
        let mut state = record.state.lock().await;
        state.worktree = Some(worktree);
        state.worktree_retained = false;
        state.worktree_error = None;
    }

    pub(crate) async fn finalize_worktree(
        &self,
        record: &AgentRecord,
        worktree: Option<AgentWorktree>,
    ) {
        if let Some(worktree) = worktree {
            let outcome = agent_worktree::finalize(&worktree).await;
            let mut state = record.state.lock().await;
            state.worktree_retained = outcome.retained;
            state.worktree_error = outcome.error;
            state.worktree = outcome.retained.then_some(worktree);
        }
        record.changed.notify_waiters();
    }

    pub(crate) async fn snapshot(&self, id: &str, record: &AgentRecord) -> Value {
        let state = record.state.lock().await;
        json!({
            "agentId": id,
            "taskId": id,
            "name": state.name,
            "description": state.description,
            "subagentType": state.agent_type,
            "model": state.model,
            "status": state.status.as_str(),
            "result": state.result,
            "error": state.error,
            "queuedMessages": state.inbox.len(),
            "worktreePath": state.worktree.as_ref().map(|worktree| worktree.path.display().to_string()),
            "worktreeBranch": state.worktree.as_ref().map(|worktree| worktree.branch.clone()),
            "worktreeRetained": state.worktree_retained,
            "worktreeError": state.worktree_error,
        })
    }

    pub(crate) async fn output(
        &self,
        id_or_name: &str,
        block: bool,
        timeout: Duration,
    ) -> Result<Value, ToolError> {
        let (id, record) = self.resolve(id_or_name).await?;
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
        Ok(self.snapshot(&id, &record).await)
    }

    pub(crate) async fn stop(&self, id_or_name: &str) -> Result<Value, ToolError> {
        let (id, record) = self.resolve(id_or_name).await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let changed = record.changed.notified();
            let mut state = record.state.lock().await;
            match state.status {
                AgentStatus::Running => {
                    state.cancel.cancel();
                    state.status = AgentStatus::Stopping;
                    state.error = Some("agent stopped by caller".into());
                }
                AgentStatus::Stopping | AgentStatus::Finalizing => {}
                AgentStatus::Completed | AgentStatus::Failed | AgentStatus::Cancelled => break,
            }
            drop(state);
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                break;
            }
        }
        Ok(self.snapshot(&id, &record).await)
    }

    pub(crate) async fn route_message(
        &self,
        id_or_name: &str,
        message: String,
    ) -> Result<MessageDisposition, ToolError> {
        let (id, record) = self.resolve(id_or_name).await?;
        loop {
            let changed = record.changed.notified();
            let mut state = record.state.lock().await;
            if state.status == AgentStatus::Running {
                state.inbox.push_back(message);
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
            if state.history.is_none() {
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
