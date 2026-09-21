//! Agent-owned image history reads still participate in the host's audit/UI lifecycle.

use super::*;

impl SessionToolExecutor {
    pub(super) fn persist_image_history(
        &self,
        call: &ToolCallRequest,
        output: &Value,
    ) -> Result<(), AgentError> {
        if self.cancel.is_cancelled() {
            return Err(AgentError::Cancelled);
        }
        // The agent resolves only references already authorized in its own
        // history. This hook records that read; it never opens arbitrary paths.
        let input = crate::security::redacted(call.arguments.clone());
        let record = self
            .state
            .store
            .create_tool_call(
                &self.session_id,
                &call.name,
                &input,
                self.owner_agent_id(),
                ToolCallStatus::Pending,
            )
            .map_err(|error| AgentError::Checkpoint(error.to_string()))?;
        self.audit(
            "tool_call",
            json!({"toolCallId":record.id, "tool":call.name, "risk":"low"}),
        );
        self.state.emit(Event::ToolCallStarted {
            session_id: self.session_id.clone(),
            agent_id: self.owner_agent_id().map(str::to_owned),
            tool_call_id: record.id.clone(),
            tool_name: call.name.clone(),
            input,
            created_at: Some(record.created_at),
        });
        let status = if output.get("error").is_some_and(|value| !value.is_null()) {
            ToolCallStatus::Failed
        } else {
            ToolCallStatus::Succeeded
        };
        self.finish(&record.id, status, output);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn fixture(agent_id: Option<&str>) -> (tempfile::TempDir, SessionToolExecutor) {
        let directory = tempfile::tempdir().unwrap();
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace(directory.path().to_str().unwrap(), "images")
            .unwrap();
        let session = store.create_session(&workspace.id, "history").unwrap();
        if let Some(id) = agent_id {
            store
                .create_agent_task(&miniq_memory::AgentTaskRow {
                    id: id.into(),
                    session_id: session.id.clone(),
                    name: id.into(),
                    parent_id: None,
                    created_at: miniq_memory::now_iso(),
                    state: json!({}),
                })
                .unwrap();
        }
        let state = AppState::new(
            store,
            "test".into(),
            Arc::new(miniq_models::mock::MockProvider::text("unused")),
        );
        let bridge = crate::agent_tasks::DaemonAgentBridge {
            state: state.clone(),
            session_id: session.id.clone(),
            workspace: directory.path().to_owned(),
            workspace_roots: vec![directory.path().to_owned()],
            workspace_id: workspace.id,
            depth: usize::from(agent_id.is_some()),
            agent_id: agent_id.map(str::to_owned),
            cancel: CancellationToken::new(),
        };
        let executor = SessionToolExecutor {
            state: state.clone(),
            session_id: session.id,
            router: state.router.clone(),
            ctx: ToolContext::new(directory.path().to_owned()).with_agents(Some(Arc::new(bridge))),
            cancel: CancellationToken::new(),
            permission_policy: PermissionPolicy::Inherit,
            review_plan: Default::default(),
        };
        (directory, executor)
    }

    #[tokio::test]
    async fn image_history_reads_emit_persisted_scoped_lifecycle_without_approval() {
        for agent_id in [None, Some("child-reader")] {
            let (_directory, executor) = fixture(agent_id);
            let mut events = executor.state.events.subscribe();
            let call = ToolCallRequest {
                id: "provider-call".into(),
                name: "image_history".into(),
                arguments: json!({"action":"read", "ids":["img_1"]}),
            };
            executor
                .record_image_history(
                    &call,
                    &json!({"image_references":["img_1"], "historical_evidence":true, "detail":"original"}),
                )
                .await
                .unwrap();
            let records = executor
                .state
                .store
                .list_tool_calls(&executor.session_id)
                .unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].tool_name, "image_history");
            assert_eq!(records[0].agent_id.as_deref(), agent_id);
            assert_eq!(records[0].status, ToolCallStatus::Succeeded);
            assert!(records[0].completed_at.is_some());
            assert_eq!(
                executor
                    .state
                    .store
                    .count_audit_events(&executor.session_id)
                    .unwrap(),
                1
            );
            assert!(
                matches!(events.recv().await.unwrap(), Event::ToolCallStarted { session_id, agent_id: owner, tool_call_id, .. }
                if session_id == executor.session_id && owner.as_deref() == agent_id && tool_call_id == records[0].id)
            );
            assert!(matches!(
                events.recv().await.unwrap(),
                Event::ToolCallFinished {
                    status: ToolCallStatus::Succeeded,
                    ..
                }
            ));
            assert!(events.try_recv().is_err());
        }
    }

    #[tokio::test]
    async fn failed_history_reads_and_sensitive_arguments_are_recorded_safely() {
        let (_directory, executor) = fixture(None);
        executor.record_image_history(&ToolCallRequest {
            id: "provider-call".into(), name: "image_history".into(),
            arguments: json!({"action":"read", "ids":["img_unknown"], "api_key":"never-log-input"}),
        }, &json!({"error":"unknown archived image", "password":"never-log-output"})).await.unwrap();
        let calls = executor
            .state
            .store
            .list_tool_calls(&executor.session_id)
            .unwrap();
        assert_eq!(calls[0].status, ToolCallStatus::Failed);
        let serialized = serde_json::to_string(&calls).unwrap();
        assert!(!serialized.contains("never-log"));
        assert!(serialized.contains("[REDACTED]"));
    }
}
