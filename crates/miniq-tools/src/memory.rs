//! memory_search / memory_write: long-term workspace and global memory.
//! Writes require approval — the agent must not persist speculation
//! silently (design doc §10).

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

fn memory_store(ctx: &ToolContext) -> Result<&std::sync::Arc<miniq_memory::Store>, ToolError> {
    ctx.memory.as_ref().ok_or_else(|| {
        ToolError::ExecutionFailed("memory is not available in this session".into())
    })
}

// ---- memory_search ----

pub struct MemorySearchTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemorySearchInput {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str {
        "memory_search"
    }
    fn description(&self) -> &str {
        "Search long-term memory (workspace conventions, user preferences, past \
         decisions) by keyword."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "description": "Max results, default 10"}
            },
            "required": ["query"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "read-only memory search".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: MemorySearchInput = parse_input(input)?;
        let store = memory_store(ctx)?;
        let rows = store
            .search_memories(
                ctx.workspace_id.as_deref(),
                &p.query,
                p.limit.unwrap_or(10).clamp(1, 50),
            )
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        Ok(json!({ "query": p.query, "memories": rows }))
    }
}

// ---- memory_write ----

pub struct MemoryWriteTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryWriteInput {
    /// "workspace" (this project) or "global" (all projects).
    scope: String,
    content: String,
}

#[async_trait]
impl Tool for MemoryWriteTool {
    fn name(&self) -> &str {
        "memory_write"
    }
    fn description(&self) -> &str {
        "Persist a durable fact to long-term memory (workspace conventions, user \
         preferences). Only store confirmed facts, never guesses. Requires approval."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope": {"type": "string", "enum": ["workspace", "global"]},
                "content": {"type": "string", "description": "The fact to remember, one self-contained sentence or paragraph"}
            },
            "required": ["scope", "content"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "writes to long-term memory".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: MemoryWriteInput = parse_input(input)?;
        if !matches!(p.scope.as_str(), "workspace" | "global") {
            return Err(ToolError::InvalidInput(format!("invalid scope: {}", p.scope)));
        }
        if p.content.trim().is_empty() {
            return Err(ToolError::InvalidInput("content is empty".into()));
        }
        let store = memory_store(ctx)?;
        let workspace_id = if p.scope == "workspace" {
            let Some(id) = &ctx.workspace_id else {
                return Err(ToolError::ExecutionFailed(
                    "workspace scope requires an open workspace".into(),
                ));
            };
            Some(id.as_str())
        } else {
            None
        };
        let row = store
            .create_memory(workspace_id, &p.scope, &p.content)
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        Ok(json!({ "id": row.id, "scope": row.scope }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ctx_with_memory() -> (ToolContext, Arc<miniq_memory::Store>, String) {
        let store = Arc::new(miniq_memory::Store::open_in_memory().unwrap());
        let ws = store.create_workspace("D:/tmp/proj", "proj").unwrap();
        let ctx = ToolContext::new(std::path::PathBuf::from("."))
            .with_memory(Some(store.clone()), Some(ws.id.clone()));
        (ctx, store, ws.id)
    }

    #[tokio::test]
    async fn write_then_search() {
        let (ctx, _store, _ws) = ctx_with_memory();
        MemoryWriteTool
            .execute(
                &ctx,
                json!({"scope": "workspace", "content": "测试命令是 cargo test --workspace"}),
            )
            .await
            .unwrap();
        MemoryWriteTool
            .execute(&ctx, json!({"scope": "global", "content": "用户偏好中文回复"}))
            .await
            .unwrap();

        let out = MemorySearchTool
            .execute(&ctx, json!({"query": "cargo"}))
            .await
            .unwrap();
        let memories = out["memories"].as_array().unwrap();
        assert_eq!(memories.len(), 1);
        assert!(memories[0]["content"].as_str().unwrap().contains("cargo test"));

        // Global memories are visible too.
        let out = MemorySearchTool
            .execute(&ctx, json!({"query": "中文"}))
            .await
            .unwrap();
        assert_eq!(out["memories"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn invalid_scope_rejected() {
        let (ctx, _store, _ws) = ctx_with_memory();
        let err = MemoryWriteTool
            .execute(&ctx, json!({"scope": "session", "content": "x"}))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
