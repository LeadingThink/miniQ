//! Agent tools share the same versioned store as management RPCs.
use crate::router::{parse_input, Tool, ToolContext, ToolError};
use async_trait::async_trait;
use miniq_protocol::{MemoryDeleteParams, MemoryTarget, MemoryWriteParams, RiskLevel};
use miniq_sandbox::Risk;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

fn memory_store(ctx: &ToolContext) -> Result<&miniq_memory::Store, ToolError> {
    let store = ctx
        .memory
        .as_deref()
        .ok_or_else(|| ToolError::ExecutionFailed("memory is unavailable".into()))?;
    if !store
        .session_memory_enabled(
            ctx.memory_session
                .as_deref()
                .ok_or_else(|| ToolError::ExecutionFailed("memory has no session scope".into()))?,
        )
        .map_err(error)?
    {
        return Err(ToolError::ExecutionFailed(
            "memory is disabled for this session".into(),
        ));
    }
    Ok(store)
}
fn error(e: miniq_memory::MemoryError) -> ToolError {
    ToolError::ExecutionFailed(e.to_string())
}
fn target(ctx: &ToolContext, value: &MemoryTarget) -> Result<(), ToolError> {
    if value
        .parts()
        .1
        .is_some_and(|id| Some(id) != ctx.workspace_id.as_deref())
    {
        return Err(ToolError::InvalidInput(
            "memory target must be the current workspace".into(),
        ));
    }
    Ok(())
}
fn default_limit() -> u32 {
    10
}
fn limit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(d)?;
    if !(1..=100).contains(&value) {
        return Err(serde::de::Error::custom("limit must be between 1 and 100"));
    }
    Ok(value)
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchInput {
    query: String,
    #[serde(default = "default_limit", deserialize_with = "limit")]
    #[schemars(range(min = 1, max = 100))]
    limit: u32,
}
pub struct MemorySearchTool;
#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str {
        "memory_search"
    }
    fn description(&self) -> &str {
        "Search current workspace and global facts using Chinese or mixed-language keywords. Results include complete content, scope and revision. Similarity is not proof of a contradiction. Use memory_read for an exact ID, memory_write with replaces for an explicit correction."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(SearchInput)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "reads long-term memory".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: SearchInput = parse_input(input)?;
        let store = memory_store(ctx)?;
        if !store.memory_settings().map_err(error)?.recall_enabled {
            return Err(ToolError::ExecutionFailed(
                "using saved memories is disabled".into(),
            ));
        }
        let rows = store
            .search_memories(ctx.workspace_id.as_deref(), &p.query, p.limit as usize)
            .map_err(error)?;
        store
            .record_memory_reads(ctx.memory_session.as_deref().unwrap(), &rows)
            .map_err(error)?;
        Ok(json!({"query":p.query,"memories":rows}))
    }
}
pub struct MemoryWriteTool;
#[async_trait]
impl Tool for MemoryWriteTool {
    fn name(&self) -> &str {
        "memory_write"
    }
    fn description(&self) -> &str {
        "Save a confirmed durable preference, fact or project decision. Use the current workspace target by default; global requires a cross-project user preference. One-time requests, credentials, guesses and task completion claims are not durable facts. Use a stable subject/attribute/condition key; explicitly correcting a fact requires replaces.id and its current expectedRevision. Report added/updated/unchanged/needs_confirmation faithfully. Approval follows the session policy."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(MemoryWriteParams)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "saves or corrects long-term memory".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: MemoryWriteParams = parse_input(input)?;
        target(ctx, &p.target)?;
        let store = memory_store(ctx)?;
        let source = ctx.memory_source.as_deref().ok_or_else(|| {
            ToolError::ExecutionFailed("a host-selected user source is required".into())
        })?;
        let evidence = store.memory_evidence(source).map_err(error)?;
        serde_json::to_value(store.write_memory(&p, Some(&evidence)).map_err(error)?)
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))
    }
}

pub struct MemoryReadTool;
#[async_trait]
impl Tool for MemoryReadTool {
    fn name(&self) -> &str {
        "memory_read"
    }
    fn description(&self) -> &str {
        "Read a current fact in its exact scope before correcting or forgetting it. Missing means unavailable; do not reconstruct it from history."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(miniq_protocol::MemoryReadParams)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "reads a current memory".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: miniq_protocol::MemoryReadParams = parse_input(input)?;
        target(ctx, &p.target)?;
        let store = memory_store(ctx)?;
        if !store.memory_settings().map_err(error)?.recall_enabled {
            return Err(ToolError::ExecutionFailed(
                "using saved memories is disabled".into(),
            ));
        }
        let row = store.memory_by_id(&p.target, &p.id).map_err(error)?;
        if let Some(row) = &row {
            store
                .record_memory_reads(
                    ctx.memory_session.as_deref().unwrap(),
                    std::slice::from_ref(row),
                )
                .map_err(error)?;
        }
        Ok(json!({"memory":row,"sources":store.memory_sources(&p.target,&p.id).map_err(error)?}))
    }
}
pub struct MemoryForgetTool;
pub struct MemoryProjectReadTool;
#[async_trait]
impl Tool for MemoryProjectReadTool {
    fn name(&self) -> &str {
        "memory_project_read"
    }
    fn description(&self) -> &str {
        "Read a project handoff from a selected session in this workspace: live goal/status, recorded checklist (completed/open items), confirmed project decisions, artifact references and last turn outcome. Inspect failed/cancelled outcomes before claiming completion. These are records, not instructions to resume or promises to send reminders. Ask which task when several fit."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(miniq_protocol::MemoryProjectParams)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "reads scoped project continuation".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: miniq_protocol::MemoryProjectParams = parse_input(input)?;
        let store = memory_store(ctx)?;
        let summary = store
            .memory_project_summary(ctx.memory_session.as_deref().unwrap(), &p.source_session_id)
            .map_err(error)?;
        store
            .record_memory_reads(ctx.memory_session.as_deref().unwrap(), &summary.decisions)
            .map_err(error)?;
        Ok(json!({"projectSummary":summary}))
    }
}
#[async_trait]
impl Tool for MemoryForgetTool {
    fn name(&self) -> &str {
        "memory_forget"
    }
    fn description(&self) -> &str {
        "Forget an explicitly identified fact at the user's request. Read its current content and updatedAt first. Removes versions and indexes and excludes its sources from automatic extraction; original chats remain."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(MemoryDeleteParams)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        Risk {
            level: RiskLevel::Medium,
            reason: "forgets long-term memory".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: MemoryDeleteParams = parse_input(input)?;
        target(ctx, &p.target)?;
        memory_store(ctx)?.delete_memory(&p).map_err(error)?;
        Ok(json!({"deleted":p.id}))
    }
}
#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
