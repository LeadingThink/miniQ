use super::PageRequest;
use crate::{Tool, ToolContext, ToolError};
use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputInput {
    #[schemars(regex(pattern = "^shell_"))]
    pub id: String,
    #[serde(default)]
    pub block: bool,
    #[serde(default)]
    #[schemars(range(min = 1, max = 600))]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    #[schemars(range(min = 0, max = 600000))]
    pub yield_time_ms: Option<u64>,
    /// Return base64 bytes instead of display text, only for explicit binary recovery.
    #[serde(default)]
    pub raw: bool,
    #[serde(default)]
    pub stdout_offset: Option<u64>,
    #[serde(default)]
    pub stderr_offset: Option<u64>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 65536))]
    pub max_output_tokens: Option<usize>,
}
impl OutputInput {
    pub fn validate(&self) -> Result<(), ToolError> {
        if self.id.is_empty()
            || self.timeout_secs.is_some_and(|v| !(1..=600).contains(&v))
            || self.yield_time_ms.is_some_and(|v| v > 600000)
            || self
                .max_output_tokens
                .is_some_and(|v| !(1..=65536).contains(&v))
            || (self.timeout_secs.is_some() && self.yield_time_ms.is_some())
        {
            return Err(ToolError::InvalidInput(
                "invalid process wait/output budget; use either timeoutSecs or yieldTimeMs".into(),
            ));
        }
        Ok(())
    }
    pub fn wait(&self) -> Duration {
        Duration::from_millis(self.yield_time_ms.unwrap_or(if self.block {
            self.timeout_secs.unwrap_or(30) * 1000
        } else {
            0
        }))
    }
    pub fn page(&self) -> PageRequest {
        PageRequest {
            stdout_offset: self.stdout_offset,
            stderr_offset: self.stderr_offset,
            max_bytes: self.max_output_tokens.unwrap_or(4096) * 4,
            raw: self.raw,
        }
    }
}
pub struct ProcessOutputTool;
#[async_trait]
impl Tool for ProcessOutputTool {
    fn name(&self) -> &str {
        "process_output"
    }
    fn description(&self) -> &str {
        "Read incremental output from an owned process. Omitted offsets consume the next page; explicit stdoutOffset/stderrOffset replay bytes without advancing the cursor. maxOutputTokens is a byte-budget estimate (4 bytes per token per stream), not an exact tokenizer. All output remains available through archiveRef while the daemon lives. Use raw=true only for lossless binary recovery. This tool only accepts shell_* process handles. For agents use agent_result or agent_wait."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(OutputInput)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        risk(RiskLevel::Low, "read process output; use shell_* handles")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: OutputInput = crate::router::parse_input(input)?;
        p.validate()?;
        if !p.id.starts_with("shell_") {
            return Err(ToolError::InvalidInput("process_output requires a shell_* handle; use agent_result({id}) for an agent, or agent_wait({ids,timeoutMs}) for any completion".into()));
        }
        ctx.processes.output(ctx, &p.id, p.wait(), p.page()).await
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    id: String,
    #[serde(default)]
    chars: String,
    #[serde(default)]
    eof: bool,
    #[serde(default)]
    #[schemars(range(min = 0, max = 600000))]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 65536))]
    max_output_tokens: Option<usize>,
}
pub struct ProcessInputTool;
#[async_trait]
impl Tool for ProcessInputTool {
    fn name(&self) -> &str {
        "process_input"
    }
    fn description(&self) -> &str {
        "Write to an owned interactive process, then wait and read incremental output. Empty chars only polls. eof closes pipe stdin or sends terminal Ctrl-D. PTYs accept terminal control characters (e.g. Ctrl-C). Nonempty input can execute commands and requires approval; never use it to bypass plan restrictions."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(Input)).unwrap()
    }
    fn approval_scope(&self, _: &ToolContext, input: &Value) -> Option<String> {
        input["id"].as_str().map(str::to_owned)
    }
    fn evaluate_risk(&self, _: &ToolContext, input: &Value) -> Risk {
        match serde_json::from_value::<Input>(input.clone()) {
            Ok(p) if p.chars.is_empty() && !p.eof => risk(RiskLevel::Low, "polls process output"),
            Ok(_) => risk(
                RiskLevel::High,
                "stdin can execute commands or authorize effects in this process",
            ),
            Err(_) => risk(RiskLevel::Blocked, "invalid process input"),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: Input = crate::router::parse_input(input)?;
        let output = OutputInput {
            id: p.id,
            block: false,
            timeout_secs: None,
            yield_time_ms: Some(p.yield_time_ms.unwrap_or(1000)),
            raw: false,
            stdout_offset: None,
            stderr_offset: None,
            max_output_tokens: p.max_output_tokens,
        };
        output.validate()?;
        ctx.processes.input(ctx, &output.id, p.chars, p.eof).await?;
        ctx.processes
            .output(ctx, &output.id, output.wait(), output.page())
            .await
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
pub struct ProcessKillTool;
#[async_trait]
impl Tool for ProcessKillTool {
    fn name(&self) -> &str {
        "process_kill"
    }
    fn description(&self) -> &str {
        "Stop an owned process group or child agent. Output remains paginated and readable."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(Id)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        risk(RiskLevel::Medium, "stops owned work")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: Id = crate::router::parse_input(input)?;
        if p.id.starts_with("agent_") {
            return ctx
                .agents
                .as_ref()
                .ok_or_else(|| ToolError::ExecutionFailed("agent runtime unavailable".into()))?
                .stop(&p.id)
                .await;
        }
        ctx.processes.kill(ctx, &p.id, PageRequest::default()).await
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Resize {
    id: String,
    #[schemars(range(min = 1, max = 1000))]
    rows: u16,
    #[schemars(range(min = 1, max = 1000))]
    cols: u16,
}
pub struct ProcessResizeTool;
#[async_trait]
impl Tool for ProcessResizeTool {
    fn name(&self) -> &str {
        "process_resize"
    }
    fn description(&self) -> &str {
        "Resize the PTY of an owned process (rows/cols 1..1000)."
    }
    fn parameters_schema(&self) -> Value {
        serde_json::to_value(schemars::schema_for!(Resize)).unwrap()
    }
    fn evaluate_risk(&self, _: &ToolContext, _: &Value) -> Risk {
        risk(RiskLevel::Medium, "changes owned terminal dimensions")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: Resize = crate::router::parse_input(input)?;
        if !(1..=1000).contains(&p.rows) || !(1..=1000).contains(&p.cols) {
            return Err(ToolError::InvalidInput("rows/cols must be 1..1000".into()));
        }
        ctx.processes.resize(ctx, &p.id, p.rows, p.cols).await
    }
}
fn risk(level: RiskLevel, reason: &str) -> Risk {
    Risk {
        level,
        reason: reason.into(),
    }
}
