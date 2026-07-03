//! SessionToolExecutor: bridges the agent runtime to the ToolRouter with
//! risk gating, approval, persistence and audit.
//!
//! Flow per call: evaluate risk -> (blocked? reject) -> (medium/high?
//! approval) -> execute -> persist + events + audit. Every path returns a
//! structured JSON result so the model can react.

use async_trait::async_trait;
use miniq_agent::{AgentError, ToolExecutor};
use miniq_models::{ToolCallRequest, ToolSpec};
use miniq_protocol::{ApprovalStatus, Event, RiskLevel, SessionStatus, ToolCallStatus};
use miniq_tools::{ToolContext, ToolRouter};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::state::{ApprovalDecision, AppState};

pub struct SessionToolExecutor {
    pub state: AppState,
    pub session_id: String,
    pub router: std::sync::Arc<ToolRouter>,
    pub ctx: ToolContext,
    pub cancel: CancellationToken,
}

impl SessionToolExecutor {
    fn audit(&self, event_type: &str, payload: Value) {
        if let Err(e) = self
            .state
            .store
            .append_audit_event(Some(&self.session_id), event_type, &payload)
        {
            tracing::error!("audit write failed: {e}");
        }
    }

    /// Pattern used for "approve for session": tool name, plus the program
    /// token for shell commands so `cargo ...` approval does not unlock `rm`.
    fn approval_pattern(&self, call: &ToolCallRequest) -> String {
        if call.name == "shell.run" {
            let program = call
                .arguments
                .get("command")
                .and_then(|c| c.as_str())
                .and_then(|c| c.split_whitespace().next())
                .unwrap_or("");
            format!("shell.run:{program}")
        } else {
            call.name.clone()
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
            .map_err(|e| AgentError::Provider(miniq_models::ProviderError::Config(e.to_string())))?;
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

    fn finish(
        &self,
        tool_call_id: &str,
        status: ToolCallStatus,
        output: &Value,
    ) {
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
            .map_err(|e| AgentError::Provider(miniq_models::ProviderError::Config(e.to_string())))?;
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
                let pattern = self.approval_pattern(call);
                if !self.state.is_allowed_for_session(&self.session_id, &pattern) {
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
        let _ = self
            .state
            .store
            .update_tool_call_status(&tool_call.id, ToolCallStatus::Running);
        self.state.emit(Event::ToolCallStarted {
            session_id: self.session_id.clone(),
            tool_call_id: tool_call.id.clone(),
            tool_name: call.name.clone(),
            input: call.arguments.clone(),
        });

        let result = tokio::select! {
            _ = self.cancel.cancelled() => {
                let output = json!({"cancelled": true});
                self.finish(&tool_call.id, ToolCallStatus::Cancelled, &output);
                return Err(AgentError::Cancelled);
            }
            result = self.router.dispatch(&self.ctx, &call.name, call.arguments.clone()) => result,
        };

        match result {
            Ok(output) => {
                self.finish(&tool_call.id, ToolCallStatus::Succeeded, &output);
                Ok(output)
            }
            Err(e) => {
                // Tool errors are surfaced to the model, not fatal to the turn.
                let output = json!({"error": e.to_string()});
                self.finish(&tool_call.id, ToolCallStatus::Failed, &output);
                Ok(output)
            }
        }
    }
}
