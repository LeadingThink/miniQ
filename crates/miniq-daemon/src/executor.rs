//! SessionToolExecutor: bridges the agent runtime to the ToolRouter with
//! risk gating, approval, persistence and audit.
//!
//! Flow per call: evaluate risk -> (blocked? reject) -> (medium/high?
//! approval) -> execute -> persist + events + audit. Every path returns a
//! structured JSON result so the model can react.

use async_trait::async_trait;
use miniq_agent::{AgentError, ToolExecutionMode, ToolExecutor};
use miniq_models::{ToolCallRequest, ToolSpec};
use miniq_protocol::{ApprovalStatus, Event, RiskLevel, SessionStatus, ToolCallStatus};
use miniq_tools::{ToolContext, ToolRouter};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::state::{AppState, ApprovalDecision};

pub struct SessionToolExecutor {
    pub state: AppState,
    pub session_id: String,
    pub router: std::sync::Arc<ToolRouter>,
    pub ctx: ToolContext,
    pub cancel: CancellationToken,
}

impl SessionToolExecutor {
    fn audit(&self, event_type: &str, payload: Value) {
        if let Err(e) =
            self.state
                .store
                .append_audit_event(Some(&self.session_id), event_type, &payload)
        {
            tracing::error!("audit write failed: {e}");
        }
    }

    /// Pattern used for "approve for session": tool name, refined so a broad
    /// grant is impossible — shell commands are scoped to the program token
    /// (approving `cargo ...` does not unlock `rm`), network tools to the
    /// target domain (approving example.com does not unlock other hosts).
    fn approval_pattern(&self, call: &ToolCallRequest) -> String {
        match call.name.as_str() {
            "shell_run" => {
                let program = call
                    .arguments
                    .get("command")
                    .and_then(|c| c.as_str())
                    .and_then(|c| c.split_whitespace().next())
                    .unwrap_or("");
                format!("shell_run:{program}")
            }
            "web_fetch" | "http_request" => {
                let host = miniq_tools::url_host(&call.arguments).unwrap_or_default();
                format!("{}:{host}", call.name)
            }
            "mcp_call" => {
                let server = call
                    .arguments
                    .get("server")
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                format!("mcp_call:{server}")
            }
            _ => call.name.clone(),
        }
    }

    /// Ask the user. Returns Ok(true) to proceed, Ok(false) if rejected.
    async fn request_approval(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
        risk: &miniq_sandbox::Risk,
    ) -> Result<bool, AgentError> {
        let approval = self
            .state
            .store
            .create_approval(&self.session_id, tool_call_id, risk.level, &risk.reason)
            .map_err(|e| {
                AgentError::Provider(miniq_models::ProviderError::Config(e.to_string()))
            })?;
        let rx = self.state.register_approval(&approval.id);

        let _ = self
            .state
            .store
            .update_session_status(&self.session_id, SessionStatus::WaitingApproval);
        self.state.emit(Event::SessionStatusChanged {
            session_id: self.session_id.clone(),
            status: SessionStatus::WaitingApproval,
        });
        self.state.emit(Event::ApprovalRequested {
            session_id: self.session_id.clone(),
            approval: approval.clone(),
            tool_name: call.name.clone(),
            input: call.arguments.clone(),
            risk_level: risk.level,
        });
        self.audit(
            "approval_requested",
            json!({"approvalId": approval.id, "tool": call.name, "risk": risk.level.as_str()}),
        );

        let decision = tokio::select! {
            _ = self.cancel.cancelled() => {
                // Turn cancelled while waiting: clean up the pending entry.
                self.state.pending_approvals.lock().unwrap().remove(&approval.id);
                let _ = self.state.store.resolve_approval(&approval.id, ApprovalStatus::Rejected);
                return Err(AgentError::Cancelled);
            }
            decision = rx => decision.unwrap_or(ApprovalDecision::Reject),
        };

        let (status, proceed) = match decision {
            ApprovalDecision::Approve => (ApprovalStatus::Approved, true),
            ApprovalDecision::ApproveForSession => {
                self.state
                    .allow_for_session(&self.session_id, &self.approval_pattern(call));
                (ApprovalStatus::ApprovedForSession, true)
            }
            ApprovalDecision::Reject => (ApprovalStatus::Rejected, false),
        };

        let resolved = self
            .state
            .store
            .resolve_approval(&approval.id, status)
            .unwrap_or(approval);
        self.state.emit(Event::ApprovalResolved {
            session_id: self.session_id.clone(),
            approval: resolved,
        });
        self.audit(
            "approval_resolved",
            json!({"tool": call.name, "status": status.as_str()}),
        );

        // Back to running for the rest of the turn.
        let _ = self
            .state
            .store
            .update_session_status(&self.session_id, SessionStatus::Running);
        self.state.emit(Event::SessionStatusChanged {
            session_id: self.session_id.clone(),
            status: SessionStatus::Running,
        });
        Ok(proceed)
    }

    /// Tools that modify files and therefore get a checkpoint backup first.
    fn is_write_tool(name: &str) -> bool {
        matches!(
            name,
            "file_write" | "file_edit" | "doc_write" | "file_patch"
        )
    }

    /// Back up the target file before a write tool runs. Returns the
    /// checkpoint id, or `None` when the input has no resolvable path.
    fn take_checkpoint(&self, call: &ToolCallRequest, tool_call_id: &str) -> Option<String> {
        let requested = call.arguments.get("path")?.as_str()?;
        let abs = miniq_sandbox::resolve_in_workspace(&self.ctx.workspace, requested).ok()?;
        let existed = abs.is_file();
        let backup_path = if existed {
            let backup = self.state.checkpoints_dir.join(format!(
                "{}-{}",
                miniq_memory::new_id("bk"),
                abs.file_name()?.to_string_lossy()
            ));
            std::fs::create_dir_all(&self.state.checkpoints_dir).ok()?;
            std::fs::copy(&abs, &backup).ok()?;
            Some(backup.to_string_lossy().to_string())
        } else {
            None
        };
        let row = self
            .state
            .store
            .create_checkpoint(
                &self.session_id,
                tool_call_id,
                &abs.to_string_lossy(),
                existed,
                backup_path.as_deref(),
            )
            .ok()?;
        Some(row.id)
    }

    /// Handle an ask_user call: emit the question event and wait for the
    /// user's answer (or cancellation).
    async fn ask_user(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
    ) -> Result<Value, AgentError> {
        let prompt = call
            .arguments
            .get("prompt")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        if prompt.trim().is_empty() {
            return Ok(json!({"error": "ask_user requires a non-empty prompt"}));
        }
        let options: Vec<String> = call
            .arguments
            .get("options")
            .and_then(|o| o.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let question = miniq_protocol::Question {
            id: miniq_memory::new_id("q"),
            session_id: self.session_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            prompt,
            options,
        };
        let rx = self.state.register_question(&question.id);

        let _ = self
            .state
            .store
            .update_session_status(&self.session_id, SessionStatus::WaitingApproval);
        self.state.emit(Event::SessionStatusChanged {
            session_id: self.session_id.clone(),
            status: SessionStatus::WaitingApproval,
        });
        self.state.emit(Event::QuestionRequested {
            session_id: self.session_id.clone(),
            question: question.clone(),
        });
        self.audit(
            "question",
            json!({"questionId": question.id, "prompt": question.prompt}),
        );

        let answer = tokio::select! {
            _ = self.cancel.cancelled() => {
                self.state.pending_questions.lock().unwrap().remove(&question.id);
                return Err(AgentError::Cancelled);
            }
            answer = rx => answer.unwrap_or_default(),
        };

        self.state.emit(Event::QuestionResolved {
            session_id: self.session_id.clone(),
            question_id: question.id,
            answer: answer.clone(),
        });
        let _ = self
            .state
            .store
            .update_session_status(&self.session_id, SessionStatus::Running);
        self.state.emit(Event::SessionStatusChanged {
            session_id: self.session_id.clone(),
            status: SessionStatus::Running,
        });
        Ok(json!({ "answer": answer }))
    }

    /// Post-success hooks: plan events for task_update, artifacts for
    /// doc_write.
    fn after_success(&self, call: &ToolCallRequest, output: &Value) {
        match call.name.as_str() {
            "task_update" => {
                let tasks: Vec<miniq_protocol::PlanTask> = call
                    .arguments
                    .get("tasks")
                    .and_then(|t| serde_json::from_value(t.clone()).ok())
                    .unwrap_or_default();
                self.state
                    .plans
                    .lock()
                    .unwrap()
                    .insert(self.session_id.clone(), tasks.clone());
                self.state.emit(Event::PlanUpdated {
                    session_id: self.session_id.clone(),
                    tasks,
                });
            }
            "doc_write" => {
                let path = output.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let kind = output.get("kind").and_then(|k| k.as_str()).unwrap_or("");
                let title = output.get("title").and_then(|t| t.as_str()).unwrap_or(path);
                if let Ok(artifact) =
                    self.state
                        .store
                        .create_artifact(&self.session_id, path, kind, title)
                {
                    self.state.emit(Event::ArtifactCreated {
                        session_id: self.session_id.clone(),
                        artifact,
                    });
                }
            }
            _ => {}
        }
    }

    async fn run_tool_call(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
    ) -> Result<Value, AgentError> {
        let _ = self
            .state
            .store
            .update_tool_call_status(tool_call_id, ToolCallStatus::Running);
        self.state.emit(Event::ToolCallStarted {
            session_id: self.session_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: call.name.clone(),
            input: call.arguments.clone(),
        });

        // ask_user is interactive: handled here, not by the router.
        if call.name == "ask_user" {
            let result = self.ask_user(call, tool_call_id).await;
            return match result {
                Ok(output) => {
                    self.finish(tool_call_id, ToolCallStatus::Succeeded, &output);
                    Ok(output)
                }
                Err(e) => {
                    let output = json!({"cancelled": true});
                    self.finish(tool_call_id, ToolCallStatus::Cancelled, &output);
                    Err(e)
                }
            };
        }

        // Back up the target before any file-mutating tool runs.
        let checkpoint_id = if Self::is_write_tool(&call.name) {
            self.take_checkpoint(call, tool_call_id)
        } else {
            None
        };

        let result = tokio::select! {
            _ = self.cancel.cancelled() => {
                let output = json!({"cancelled": true});
                self.finish(tool_call_id, ToolCallStatus::Cancelled, &output);
                return Err(AgentError::Cancelled);
            }
            result = self.router.dispatch(&self.ctx, &call.name, call.arguments.clone()) => result,
        };

        match result {
            Ok(mut output) => {
                if let Some(id) = checkpoint_id {
                    output["checkpointId"] = json!(id);
                }
                self.after_success(call, &output);
                self.finish(tool_call_id, ToolCallStatus::Succeeded, &output);
                Ok(output)
            }
            Err(e) => {
                // Tool errors are surfaced to the model, not fatal to the turn.
                let output = json!({"error": e.to_string()});
                self.finish(tool_call_id, ToolCallStatus::Failed, &output);
                Ok(output)
            }
        }
    }

    fn finish(&self, tool_call_id: &str, status: ToolCallStatus, output: &Value) {
        if let Err(e) = self
            .state
            .store
            .finish_tool_call(tool_call_id, status, Some(output))
        {
            tracing::error!("tool call persist failed: {e}");
        }
        self.state.emit(Event::ToolCallFinished {
            session_id: self.session_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            status,
            output: Some(output.clone()),
        });
    }
}

#[async_trait]
impl ToolExecutor for SessionToolExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        self.router.specs()
    }

    fn execution_mode(&self, call: &ToolCallRequest) -> ToolExecutionMode {
        match call.name.as_str() {
            "file_read" | "file_list" | "file_glob" | "file_grep" | "git_status" | "git_diff"
            | "doc_read" | "skill_read" | "memory_search" => ToolExecutionMode::Parallel,
            _ => ToolExecutionMode::Sequential,
        }
    }

    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        // 1. Risk evaluation (unknown tools are reported back to the model).
        let risk = match self.router.evaluate(&self.ctx, &call.name, &call.arguments) {
            Ok(risk) => risk,
            Err(e) => {
                return Ok(json!({"error": e.to_string()}));
            }
        };

        // 2. Persist the call row before anything runs.
        let tool_call = self
            .state
            .store
            .create_tool_call(
                &self.session_id,
                &call.name,
                &call.arguments,
                ToolCallStatus::Pending,
            )
            .map_err(|e| {
                AgentError::Provider(miniq_models::ProviderError::Config(e.to_string()))
            })?;
        self.audit(
            "tool_call",
            json!({"toolCallId": tool_call.id, "tool": call.name, "risk": risk.level.as_str()}),
        );

        // 3. Gate by risk level.
        match risk.level {
            RiskLevel::Blocked => {
                let output = json!({
                    "rejected": true,
                    "riskLevel": "blocked",
                    "reason": risk.reason,
                });
                self.finish(&tool_call.id, ToolCallStatus::Rejected, &output);
                return Ok(output);
            }
            RiskLevel::Low => {}
            RiskLevel::Medium | RiskLevel::High => {
                let mode = self.state.settings.lock().unwrap().approval_mode;
                let pattern = self.approval_pattern(call);
                let pre_approved = match mode {
                    crate::state::ApprovalMode::FullAccess => true,
                    // Auto ("替我审批"): medium-risk actions (workspace writes,
                    // build/test commands — all checkpointed or reversible) run
                    // without asking; only high risk (arbitrary network,
                    // dangerous commands) needs the user, once per pattern.
                    crate::state::ApprovalMode::Auto => {
                        risk.level == RiskLevel::Medium
                            || self
                                .state
                                .is_allowed_for_session(&self.session_id, &pattern)
                    }
                    crate::state::ApprovalMode::AlwaysAsk => false,
                };
                if !pre_approved {
                    let _ = self
                        .state
                        .store
                        .update_tool_call_status(&tool_call.id, ToolCallStatus::WaitingApproval);
                    let approved = self.request_approval(call, &tool_call.id, &risk).await?;
                    if !approved {
                        let output = json!({
                            "rejected": true,
                            "riskLevel": risk.level.as_str(),
                            "reason": "user rejected the operation",
                        });
                        self.finish(&tool_call.id, ToolCallStatus::Rejected, &output);
                        return Ok(output);
                    }
                }
            }
        }

        // 4. Execute.
        self.run_tool_call(call, &tool_call.id).await
    }
}
