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

mod adaptation;
mod checkpoint;
mod hooks;
mod interaction;
mod plan;

use adaptation::unknown_tool_output;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum PermissionPolicy {
    #[default]
    Inherit,
    AcceptEdits,
    DontAsk,
}

#[cfg(test)]
use interaction::{unattended_default, wait_for_question_answer};

pub struct SessionToolExecutor {
    pub state: AppState,
    pub session_id: String,
    pub router: std::sync::Arc<ToolRouter>,
    pub ctx: ToolContext,
    pub cancel: CancellationToken,
    pub(crate) permission_policy: PermissionPolicy,
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
            "browser_automation" => {
                let action = call
                    .arguments
                    .get("action")
                    .and_then(|value| value.as_str())
                    .unwrap_or("interaction");
                let host = call
                    .arguments
                    .get("url")
                    .and_then(|value| value.as_str())
                    .and_then(|value| url::Url::parse(value).ok())
                    .and_then(|value| value.host_str().map(str::to_string))
                    .unwrap_or_else(|| "active-page".into());
                format!("browser_automation:{action}:{host}")
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
            input: crate::security::redacted(call.arguments.clone()),
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
            input: crate::security::redacted(call.arguments.clone()),
        });

        // ask_user is interactive: handled here, not by the router.
        if call.name == "ask_user" {
            if let Err(error) = miniq_tools::validate_ask_user_input(&call.arguments) {
                let output = json!({"error": error.to_string()});
                self.finish(tool_call_id, ToolCallStatus::Failed, &output);
                return Ok(output);
            }
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
        let checkpoint_ids = self.take_checkpoints(call, tool_call_id);

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
                if let Some(id) = checkpoint_ids.first() {
                    output["checkpointId"] = json!(id);
                }
                if checkpoint_ids.len() > 1 {
                    output["checkpointIds"] = json!(checkpoint_ids);
                }
                hooks::after_success(self, call, &output);
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
        let redacted_output = crate::security::redacted(output.clone());
        if let Err(e) =
            self.state
                .store
                .finish_tool_call(tool_call_id, status, Some(&redacted_output))
        {
            tracing::error!("tool call persist failed: {e}");
        }
        self.state.emit(Event::ToolCallFinished {
            session_id: self.session_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            status,
            output: Some(redacted_output),
        });
    }
}

#[async_trait]
impl ToolExecutor for SessionToolExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        self.router.specs()
    }

    fn execution_mode(&self, call: &ToolCallRequest) -> ToolExecutionMode {
        let name = miniq_tools::canonical_native_tool_name(&call.name).unwrap_or(&call.name);
        match name {
            "file_read" | "file_list" | "file_glob" | "file_grep" | "git_status" | "git_diff"
            | "doc_read" | "skill_read" | "memory_search" => ToolExecutionMode::Parallel,
            _ => ToolExecutionMode::Sequential,
        }
    }

    fn call_fingerprint(&self, call: &ToolCallRequest) -> String {
        let adapted = miniq_tools::adapt_native_tool_call(call).ok().flatten();
        let call = adapted
            .as_ref()
            .map(|adapted| &adapted.call)
            .unwrap_or(call);
        serde_json::to_string(&(&call.name, &call.arguments)).unwrap_or_default()
    }

    async fn execute(&self, call: &ToolCallRequest) -> Result<Value, AgentError> {
        let adapted = match miniq_tools::adapt_native_tool_call(call) {
            Ok(adapted) => adapted,
            Err(error) => {
                let output = json!({
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "requestedTool": error.requested_tool,
                    }
                });
                let tool_call = self
                    .state
                    .store
                    .create_tool_call(
                        &self.session_id,
                        &call.name,
                        &crate::security::redacted(call.arguments.clone()),
                        ToolCallStatus::Pending,
                    )
                    .map_err(|e| {
                        AgentError::Provider(miniq_models::ProviderError::Config(e.to_string()))
                    })?;
                self.audit(
                    "native_tool_adaptation_failed",
                    json!({"toolCallId": tool_call.id, "requestedTool": call.name, "code": error.code}),
                );
                self.state.emit(Event::ToolCallStarted {
                    session_id: self.session_id.clone(),
                    tool_call_id: tool_call.id.clone(),
                    tool_name: call.name.clone(),
                    input: crate::security::redacted(call.arguments.clone()),
                });
                self.finish(&tool_call.id, ToolCallStatus::Failed, &output);
                return Ok(output);
            }
        };
        let call = adapted
            .as_ref()
            .map(|adapted| &adapted.call)
            .unwrap_or(call);

        // 1. Persist every attempted call, including provider-invented names.
        let tool_call = self
            .state
            .store
            .create_tool_call(
                &self.session_id,
                &call.name,
                &crate::security::redacted(call.arguments.clone()),
                ToolCallStatus::Pending,
            )
            .map_err(|e| {
                AgentError::Provider(miniq_models::ProviderError::Config(e.to_string()))
            })?;
        if let Some(adapted) = &adapted {
            self.audit(
                "native_tool_adapted",
                json!({
                    "toolCallId": tool_call.id,
                    "requestedTool": adapted.original_name,
                    "tool": call.name,
                    "providerCallId": call.id,
                }),
            );
        }

        // 2. Risk evaluation. Unknown calls are visible in history and give
        // the model the exact current tool list so it can recover next round.
        let risk = match self.router.evaluate(&self.ctx, &call.name, &call.arguments) {
            Ok(risk) => risk,
            Err(error) => {
                let output = unknown_tool_output(&self.router, call, &error);
                self.audit(
                    "unknown_tool",
                    json!({"toolCallId": tool_call.id, "tool": call.name}),
                );
                self.state.emit(Event::ToolCallStarted {
                    session_id: self.session_id.clone(),
                    tool_call_id: tool_call.id.clone(),
                    tool_name: call.name.clone(),
                    input: crate::security::redacted(call.arguments.clone()),
                });
                self.finish(&tool_call.id, ToolCallStatus::Failed, &output);
                return Ok(output);
            }
        };
        self.audit(
            "tool_call",
            json!({"toolCallId": tool_call.id, "tool": call.name, "risk": risk.level.as_str()}),
        );

        if self.ctx.plan_mode() && !plan::plan_mode_allows(call, risk.level) {
            let output = json!({
                "rejected": true,
                "riskLevel": "blocked",
                "reason": "tool is unavailable while plan mode is active; call plan_mode with action=exit before changing the workspace",
            });
            self.finish(&tool_call.id, ToolCallStatus::Rejected, &output);
            return Ok(output);
        }

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
                let allowed_for_session = self
                    .state
                    .is_allowed_for_session(&self.session_id, &pattern);
                let pre_approved = match self.permission_policy {
                    PermissionPolicy::AcceptEdits => {
                        risk.level == RiskLevel::Medium
                            || mode == crate::state::ApprovalMode::FullAccess
                            || allowed_for_session
                    }
                    PermissionPolicy::DontAsk => {
                        mode == crate::state::ApprovalMode::FullAccess || allowed_for_session
                    }
                    PermissionPolicy::Inherit => match mode {
                        crate::state::ApprovalMode::FullAccess => true,
                        // Auto ("替我审批"): medium-risk actions (workspace writes,
                        // build/test commands -- all checkpointed or reversible) run
                        // without asking; only high risk needs the user once per pattern.
                        crate::state::ApprovalMode::Auto => {
                            risk.level == RiskLevel::Medium || allowed_for_session
                        }
                        crate::state::ApprovalMode::AlwaysAsk => false,
                    },
                };
                if !pre_approved {
                    if self.permission_policy == PermissionPolicy::DontAsk {
                        let output = json!({
                            "rejected": true,
                            "riskLevel": risk.level.as_str(),
                            "reason": "agent permission mode dontAsk denied an action requiring approval",
                        });
                        self.finish(&tool_call.id, ToolCallStatus::Rejected, &output);
                        return Ok(output);
                    }
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

#[cfg(test)]
mod tests;
