//! Managed Claude-compatible child agents and background lifecycle.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use miniq_agent::{run_turn_with_limits, RunLimits};
use miniq_models::ChatMessage;
use miniq_tools::{AgentBridge, AgentMessageRequest, AgentRunRequest, ToolContext, ToolError};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub(crate) use crate::agent_task_manager::AgentTaskManager;
use crate::agent_task_manager::{AgentRecord, MessageDisposition};
use crate::agent_worktree::{self, AgentWorktree};
use crate::executor::{PermissionPolicy, SessionToolExecutor};
use crate::state::{AppState, ApprovalMode};

const MAX_AGENT_DEPTH: usize = 3;

#[derive(Clone)]
pub(crate) struct DaemonAgentBridge {
    pub state: AppState,
    pub session_id: String,
    pub workspace: PathBuf,
    pub workspace_roots: Vec<PathBuf>,
    pub workspace_id: String,
    pub depth: usize,
    pub agent_id: Option<String>,
    pub cancel: CancellationToken,
}

impl DaemonAgentBridge {
    async fn execute_agent(
        &self,
        record: Arc<AgentRecord>,
        request: AgentRunRequest,
        mut history: Vec<ChatMessage>,
        workspace: PathBuf,
        worktree: Option<AgentWorktree>,
    ) {
        let cancel = self.state.agent_tasks.cancel_token(&record).await;
        let config = match self
            .state
            .provider_config_for_session(&self.session_id, request.model.as_deref())
        {
            Ok(config) => config,
            Err(error) => {
                self.state
                    .agent_tasks
                    .fail_start(&record, &ToolError::ExecutionFailed(error.to_string()))
                    .await;
                return;
            }
        };
        self.state
            .agent_tasks
            .bind_model_context(
                &record,
                &mut history,
                crate::session_models::model_identity(config.as_ref()),
            )
            .await;
        let provider = self.state.provider_from_config(config);
        let mut prompt = request.prompt.clone();
        loop {
            history.push(ChatMessage::user(prompt));
            self.state.agent_tasks.save_history(&record, &history).await;
            let executor = SessionToolExecutor {
                state: self.state.clone(),
                session_id: self.session_id.clone(),
                router: self.state.router.clone(),
                ctx: self.child_context(
                    workspace.clone(),
                    &record.id,
                    cancel.clone(),
                    worktree.is_some(),
                ),
                cancel: cancel.clone(),
                permission_policy: permission_policy(&request),
                review_plan: Default::default(),
            };
            if request.mode.as_deref() == Some("plan") {
                executor.ctx.set_plan_mode(true);
            }
            let (events, mut receiver) = tokio::sync::mpsc::channel(128);
            let progress_state = self.state.clone();
            let progress_record = record.clone();
            let drain = tokio::spawn(async move {
                while let Some(event) = receiver.recv().await {
                    if let Some(progress) = crate::agent_progress::from_event(event) {
                        crate::agent_progress::record_retry(
                            &progress_state,
                            &progress_record.session_id,
                            Some(&progress_record.id),
                            &progress,
                        );
                        progress_state
                            .agent_tasks
                            .update_progress(&progress_record, progress)
                            .await;
                    }
                }
            });
            let outcome = run_turn_with_limits(
                provider.as_ref(),
                &executor,
                history,
                events,
                cancel.clone(),
                RunLimits {
                    checkpoint: Some(Arc::new(crate::turn_checkpoint::AgentCheckpoint {
                        manager: self.state.agent_tasks.clone(),
                        record: record.clone(),
                    })),
                    max_steps: Some(request.max_turns.unwrap_or(32)),
                    ..RunLimits::default()
                },
            )
            .await;
            let _ = drain.await;
            match outcome {
                Ok(outcome) => {
                    let next = self
                        .state
                        .agent_tasks
                        .finish_turn(&record, outcome.final_text, outcome.provider_history)
                        .await;
                    let Some((message, next_history)) = next else {
                        self.state
                            .agent_tasks
                            .finalize_worktree(&record, worktree)
                            .await;
                        self.state.agent_tasks.complete(&record).await;
                        return;
                    };
                    history = next_history;
                    prompt = message;
                }
                Err(error) => {
                    self.state
                        .agent_tasks
                        .finalize_worktree(&record, worktree)
                        .await;
                    self.state.agent_tasks.finish_error(&record, &error).await;
                    return;
                }
            }
        }
    }

    fn child_context(
        &self,
        workspace: PathBuf,
        agent_id: &str,
        cancel: CancellationToken,
        isolated: bool,
    ) -> ToolContext {
        let roots = self.child_roots(&workspace, isolated);
        ToolContext::new(workspace.clone())
            .with_workspace_roots(roots.clone())
            .with_observations(self.state.observations_dir.clone())
            .with_skills(Some(self.state.skills.clone()))
            .with_memory(
                Some(self.state.store.clone()),
                Some(self.workspace_id.clone()),
            )
            .with_mcp(self.state.mcp_bridge())
            .with_processes(self.state.processes.clone())
            .with_tasks(
                self.state.tasks.clone(),
                format!("{}:{agent_id}", self.session_id),
            )
            .with_agents(Some(Arc::new(Self {
                state: self.state.clone(),
                session_id: self.session_id.clone(),
                workspace,
                workspace_roots: roots,
                workspace_id: self.workspace_id.clone(),
                depth: self.depth + 1,
                agent_id: Some(agent_id.to_owned()),
                cancel,
            })))
    }

    fn child_roots(&self, workspace: &std::path::Path, isolated: bool) -> Vec<PathBuf> {
        if !isolated {
            return self.workspace_roots.clone();
        }
        // Even a worktree inside an attached parent must not grant the source checkout.
        let mut roots = vec![workspace.to_path_buf()];
        roots.extend(
            self.workspace_roots
                .iter()
                .filter(|root| {
                    !self.workspace.starts_with(root) && !root.starts_with(&self.workspace)
                })
                .cloned(),
        );
        roots
    }

    async fn resolve_workspace(
        &self,
        id: &str,
        record: &AgentRecord,
        request: &AgentRunRequest,
    ) -> Result<(PathBuf, Option<AgentWorktree>), ToolError> {
        if request.isolation.as_deref() == Some("worktree") {
            if let Some(worktree) = self.state.agent_tasks.worktree(record).await {
                if worktree.path.is_dir() {
                    return Ok((worktree.path.clone(), Some(worktree)));
                }
                return Err(ToolError::ExecutionFailed(format!(
                    "retained agent worktree is missing: {}",
                    worktree.path.display()
                )));
            }
            let worktree = agent_worktree::create(&self.workspace, id).await?;
            let path = worktree.path.clone();
            self.state
                .agent_tasks
                .set_worktree(record, worktree.clone())
                .await;
            return Ok((path, Some(worktree)));
        }

        let workspace = match request.cwd.as_deref() {
            Some(cwd) => {
                miniq_sandbox::resolve_in_roots(&self.workspace, &self.workspace_roots, cwd)
                    .map_err(|error| ToolError::SandboxDenied(error.to_string()))?
            }
            None => self.workspace.clone(),
        };
        if !workspace.is_dir() {
            return Err(ToolError::InvalidInput(format!(
                "agent cwd is not a directory: {}",
                workspace.display()
            )));
        }
        Ok((workspace, None))
    }

    async fn run_managed(&self, mut request: AgentRunRequest) -> Result<Value, ToolError> {
        if self.cancel.is_cancelled() {
            return Err(ToolError::ExecutionFailed(
                "parent agent is cancelled".into(),
            ));
        }
        if self.depth >= MAX_AGENT_DEPTH {
            return Err(ToolError::ExecutionFailed(format!(
                "agent nesting limit reached ({MAX_AGENT_DEPTH})"
            )));
        }
        request.validate()?;
        if request.resume.is_none() && request.model.is_none() {
            request.model = self
                .state
                .provider_config_for_session(&self.session_id, None)
                .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
                .map(|config| config.model);
        }
        let cancel = self.cancel.child_token();
        let resuming = request.resume.is_some();
        let (id, record, resumed_history) = match request.resume.clone() {
            Some(resume) => {
                self.state
                    .agent_tasks
                    .prepare_resume(&self.session_id, &resume, &mut request, cancel)
                    .await?
            }
            None => {
                let (id, record) = self
                    .state
                    .agent_tasks
                    .create(&self.session_id, self.agent_id.as_deref(), &request, cancel)
                    .await?;
                (id, record, Vec::new())
            }
        };
        if let Err(error) = validate_permission_mode(&self.state, &request) {
            if resuming {
                self.state.agent_tasks.fail_start(&record, &error).await;
            } else {
                self.state.agent_tasks.discard(&id, &record).await;
            }
            return Err(error);
        }
        let (workspace, worktree) = match self.resolve_workspace(&id, &record, &request).await {
            Ok(workspace) => workspace,
            Err(error) => {
                if resuming {
                    self.state.agent_tasks.fail_start(&record, &error).await;
                } else {
                    self.state.agent_tasks.discard(&id, &record).await;
                }
                return Err(error);
            }
        };
        let history = if resuming {
            resumed_history
        } else {
            let system = format!(
                "You are a miniQ child agent of type '{}'. Default working directory: '{}'. Authorized project directories: {:?}. Use absolute paths for the other attached directories. Complete the delegated task and return a concise result to the parent. All tool calls remain subject to miniQ approvals and attached-directory sandboxing.",
                request.subagent_type.as_deref().unwrap_or("general-purpose"),
                workspace.display(),
                self.child_roots(&workspace, worktree.is_some())
            );
            vec![ChatMessage::system(system)]
        };
        let running = self.state.agent_tasks.snapshot(&id, &record).await;
        let bridge = self.clone();
        let background = request.run_in_background;
        let task = async move {
            bridge
                .execute_agent(record, request, history, workspace, worktree)
                .await;
        };
        if background {
            tokio::spawn(task);
            return Ok(running);
        }
        task.await;
        self.state
            .agent_tasks
            .output(&self.session_id, &id, false, Duration::ZERO)
            .await
    }
}

#[async_trait]
impl AgentBridge for DaemonAgentBridge {
    fn owner_agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    async fn run(&self, request: AgentRunRequest) -> Result<Value, ToolError> {
        let bridge = self.clone();
        // The calling tool future may be dropped on cancellation. Keep startup,
        // final state transitions, and worktree cleanup owned by the runtime.
        tokio::spawn(async move { bridge.run_managed(request).await })
            .await
            .map_err(|error| ToolError::ExecutionFailed(format!("agent task failed: {error}")))?
    }

    async fn output(&self, id: &str, block: bool, timeout: Duration) -> Result<Value, ToolError> {
        self.state
            .agent_tasks
            .output(&self.session_id, id, block, timeout)
            .await
    }

    async fn stop(&self, id: &str) -> Result<Value, ToolError> {
        self.state.agent_tasks.stop(&self.session_id, id).await
    }

    async fn send(&self, request: AgentMessageRequest) -> Result<Value, ToolError> {
        match self
            .state
            .agent_tasks
            .route_message(&self.session_id, &request.recipient, request.message)
            .await?
        {
            MessageDisposition::Queued(result) => Ok(result),
            MessageDisposition::Resume(request) => self.run(*request).await,
        }
    }
}

fn validate_permission_mode(state: &AppState, request: &AgentRunRequest) -> Result<(), ToolError> {
    if request.mode.as_deref() == Some("bypassPermissions")
        && state.settings.lock().unwrap().approval_mode != ApprovalMode::FullAccess
    {
        return Err(ToolError::SandboxDenied(
            "bypassPermissions requires miniQ Full Access mode".into(),
        ));
    }
    Ok(())
}

fn permission_policy(request: &AgentRunRequest) -> PermissionPolicy {
    match request.mode.as_deref() {
        Some("acceptEdits") => PermissionPolicy::AcceptEdits,
        Some("dontAsk") => PermissionPolicy::DontAsk,
        _ => PermissionPolicy::Inherit,
    }
}

#[cfg(test)]
#[path = "agent_tasks_tests.rs"]
mod tests;
