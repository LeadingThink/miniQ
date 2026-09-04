//! skill_read: pull a skill's body (and sidecar file list) into the
//! conversation on demand. Skills are advertised in the system prompt; this
//! tool is how the agent opens one.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub struct SkillReadTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillReadInput {
    name: String,
    #[serde(default)]
    args: Option<String>,
}

#[async_trait]
impl Tool for SkillReadTool {
    fn name(&self) -> &str {
        "skill_read"
    }
    fn description(&self) -> &str {
        "Read a skill listed in <available_skills>: returns its step-by-step body and \
         any bundled script/template files. Follow the steps it describes."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Skill name exactly as listed in <available_skills>"},
                "args": {"type": "string", "description": "Optional arguments supplied when invoking the skill"}
            },
            "required": ["name"]
        })
    }
    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "read-only skill lookup".into(),
        }
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: SkillReadInput = parse_input(input)?;
        let Some(store) = &ctx.skills else {
            return Err(ToolError::ExecutionFailed(
                "skill system is not available in this session".into(),
            ));
        };
        let detail = store
            .read(Some(&ctx.workspace), &p.name)
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        if !detail.skill.enabled {
            return Err(ToolError::ExecutionFailed(format!(
                "skill {} is disabled",
                p.name
            )));
        }
        let mut out = json!({
            "name": detail.skill.meta.name,
            "description": detail.skill.meta.description,
            "version": detail.skill.meta.version,
            "body": detail.body,
            "files": detail.files,
            "args": p.args,
        });
        if let Some(dir) = detail.skill_dir {
            out["skillDir"] = json!(dir);
            if !out["files"].as_array().unwrap().is_empty() {
                out["note"] = json!(
                    "This skill bundles files. Reference them via the absolute skillDir \
                     path; run scripts with shell_run."
                );
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_skills::{BundledSkill, SkillStore};
    use std::sync::Arc;

    const DEMO: &str =
        "---\nname: demo-skill\ndescription: demo\n---\n\n## Steps\n1. use file_list\n";

    #[tokio::test]
    async fn reads_skill_body() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(SkillStore::new(
            data.path(),
            vec![BundledSkill { content: DEMO }],
        ));
        let ctx = ToolContext::new(std::path::PathBuf::from(".")).with_skills(Some(store));
        let out = SkillReadTool
            .execute(&ctx, json!({"name": "demo-skill"}))
            .await
            .unwrap();
        assert!(out["body"].as_str().unwrap().contains("file_list"));
    }

    #[tokio::test]
    async fn disabled_and_unknown_error() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(SkillStore::new(
            data.path(),
            vec![BundledSkill { content: DEMO }],
        ));
        store.set_enabled("demo-skill", false).unwrap();
        let ctx = ToolContext::new(std::path::PathBuf::from(".")).with_skills(Some(store));
        let err = SkillReadTool
            .execute(&ctx, json!({"name": "demo-skill"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("disabled"));

        let err = SkillReadTool
            .execute(&ctx, json!({"name": "nope"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }
}
