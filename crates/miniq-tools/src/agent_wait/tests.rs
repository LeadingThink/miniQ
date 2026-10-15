use super::*;
use crate::{AgentBridge, AgentMessageRequest, AgentRunRequest};
use std::sync::Arc;

struct Bridge;
#[async_trait]
impl AgentBridge for Bridge {
    async fn run(&self, _: AgentRunRequest) -> Result<Value, ToolError> {
        unreachable!()
    }
    async fn stop(&self, _: &str) -> Result<Value, ToolError> {
        unreachable!()
    }
    async fn send(&self, _: AgentMessageRequest) -> Result<Value, ToolError> {
        unreachable!()
    }
    async fn output(&self, id: &str, block: bool, timeout: Duration) -> Result<Value, ToolError> {
        if id == "agent_foreign" {
            return Err(ToolError::InvalidInput("not owned".into()));
        }
        if id == "agent_done" {
            return Ok(json!({"status":"completed","result":"complete result"}));
        }
        if !block {
            return Ok(json!({"status":"running"}));
        }
        if id == "agent_fast" {
            tokio::time::sleep(Duration::from_millis(10)).await;
            return Ok(json!({"status":"completed","result":"done"}));
        }
        tokio::time::sleep(timeout).await;
        Ok(json!({"status":"running"}))
    }
}
#[tokio::test]
async fn agent_result_is_nonblocking_complete_and_session_scoped() {
    let ctx = ToolContext::new(std::env::temp_dir()).with_agents(Some(Arc::new(Bridge)));
    let tool = crate::AgentResultTool;
    assert_eq!(
        tool.execute(&ctx, json!({"id":"agent_done"}))
            .await
            .unwrap()["result"],
        "complete result"
    );
    assert_eq!(
        tool.execute(&ctx, json!({"id":"agent_slow"}))
            .await
            .unwrap()["status"],
        "running"
    );
    assert!(tool
        .execute(&ctx, json!({"id":"agent_foreign"}))
        .await
        .is_err());
}

#[tokio::test]
async fn waits_for_any_target_without_blocking_on_first_and_validates_all_owners() {
    let ctx = ToolContext::new(std::env::temp_dir()).with_agents(Some(Arc::new(Bridge)));
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        AgentWaitTool.execute(
            &ctx,
            json!({"ids":["agent_slow","agent_fast"],"timeoutMs":5000}),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["status"]["agent_fast"]["result"], "done");
    assert_eq!(result["timed_out"], false);
    assert!(AgentWaitTool
        .execute(&ctx, json!({"ids":["agent_fast","agent_foreign"]}))
        .await
        .is_err());
}
#[tokio::test]
async fn timeout_is_not_completion_and_wait_can_be_cancelled() {
    let ctx = ToolContext::new(std::env::temp_dir()).with_agents(Some(Arc::new(Bridge)));
    let result = AgentWaitTool
        .execute(&ctx, json!({"ids":["agent_slow"],"timeoutMs":5}))
        .await
        .unwrap();
    assert_eq!(result["timed_out"], true);
    ctx.cancellation.cancel();
    assert!(AgentWaitTool
        .execute(&ctx, json!({"ids":["agent_slow"],"timeoutMs":600000}))
        .await
        .is_err());
    assert!(AgentWaitTool
        .execute(&ctx, json!({"ids":[],"timeoutMs":1}))
        .await
        .is_err());
}
