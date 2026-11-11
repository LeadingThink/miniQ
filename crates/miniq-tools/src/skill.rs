//! Discover skills and load their bodies on demand.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub struct SkillReadTool;

pub struct SkillSearchTool;

const DEFAULT_SEARCH_LIMIT: usize = 20;
const MAX_SEARCH_LIMIT: usize = 100;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillSearchInput {
    #[serde(default)]
    query: String,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
}

impl SkillSearchTool {
    pub fn tool_spec() -> miniq_models::ToolSpec {
        miniq_models::ToolSpec {
            name: "skill_search".into(),
            description: "Search enabled skills by name or description.".into(),
            parameters: json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "query": {"type": "string", "description": "Search words"},
                    "offset": {"type": "integer", "minimum": 0},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_SEARCH_LIMIT}
                }
            }),
        }
    }
}

#[async_trait]
impl Tool for SkillSearchTool {
    fn name(&self) -> &str {
        "skill_search"
    }

    fn description(&self) -> &str {
        "Search enabled skills by name or description."
    }

    fn parameters_schema(&self) -> Value {
        Self::tool_spec().parameters
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "read-only skill search".into(),
        }
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: SkillSearchInput = parse_input(input)?;
        if input
            .limit
            .is_some_and(|limit| !(1..=MAX_SEARCH_LIMIT).contains(&limit))
        {
            return Err(ToolError::InvalidInput(
                "limit must be between 1 and 100".into(),
            ));
        }
        let Some(store) = &ctx.skills else {
            return Err(ToolError::ExecutionFailed(
                "skill system is not available in this session".into(),
            ));
        };
        let skills = store.discover(Some(&ctx.workspace));
        let query_is_empty = input.query.trim().is_empty();
        let mut matches = if query_is_empty {
            skills.into_iter().filter(|skill| skill.enabled).collect()
        } else {
            let terms = miniq_skills::query_terms(input.query.trim());
            miniq_skills::shortlist_skills(&skills, &terms, usize::MAX)
        };
        if query_is_empty {
            matches.sort_by(|left, right| left.meta.name.cmp(&right.meta.name));
        }
        let total = matches.len();
        let limit = input.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
        let results = matches
            .into_iter()
            .skip(input.offset)
            .take(limit)
            .map(|skill| {
                json!({
                    "name": skill.meta.name,
                    "description": skill.meta.description,
                })
            })
            .collect::<Vec<_>>();
        let next_offset = input.offset + results.len();
        Ok(json!({
            "query": input.query,
            "skills": results,
            "total": total,
            "offset": input.offset,
            "nextOffset": (next_offset < total).then_some(next_offset),
        }))
    }
}

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
        "Read a skill by name from skill_search or <available_skills>. Follow its instructions."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Exact skill name"},
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
        if !detail.skill.meta.agents.is_empty() {
            out["agents"] = json!(detail.skill.meta.agents);
            out["agentsNote"] = json!(
                "Delegate each role with agent_run, passing its model. A model name that \
                 is not in the catalog fails before start with the closest IDs; ask the \
                 user before substituting another model."
            );
        }
        if let Some(display_name) = detail.skill.meta.display_name {
            out["displayName"] = json!(display_name);
        }
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
        "---\nname: demo-skill\ndisplayName: Demo skill\ndescription: demo\n---\n\n## Steps\n1. use file_list\n";

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
        assert_eq!(out["displayName"], "Demo skill");
    }

    #[tokio::test]
    async fn searches_enabled_skills_without_loading_their_bodies() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(SkillStore::new(
            data.path(),
            vec![BundledSkill { content: DEMO }],
        ));
        let ctx = ToolContext::new(std::path::PathBuf::from(".")).with_skills(Some(store));
        let out = SkillSearchTool
            .execute(&ctx, json!({"query": "demo"}))
            .await
            .unwrap();
        assert_eq!(out["total"], 1);
        assert_eq!(out["skills"][0]["name"], "demo-skill");
        assert!(out["skills"][0].get("body").is_none());
        let detail = SkillReadTool
            .execute(&ctx, json!({"name": out["skills"][0]["name"]}))
            .await
            .unwrap();
        assert!(detail["body"].as_str().unwrap().contains("file_list"));
    }

    #[tokio::test]
    async fn search_pages_plugin_skills_and_excludes_disabled_skills() {
        let data = tempfile::tempdir().unwrap();
        let plugin = data.path().join("plugin-skill");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(
            plugin.join("SKILL.md"),
            "---\nname: plugin-skill\ndescription: demo plugin\n---\nPlugin instructions",
        )
        .unwrap();
        let store = Arc::new(SkillStore::new(
            data.path(),
            vec![BundledSkill { content: DEMO }],
        ));
        store.set_plugin_skill_dirs(vec![plugin]);
        let ctx = ToolContext::new(data.path().to_path_buf()).with_skills(Some(store.clone()));
        let first = SkillSearchTool
            .execute(&ctx, json!({"limit": 1}))
            .await
            .unwrap();
        assert_eq!(first["total"], 2);
        assert_eq!(first["nextOffset"], 1);
        let second = SkillSearchTool
            .execute(&ctx, json!({"offset": 1, "limit": 1}))
            .await
            .unwrap();
        assert_eq!(second["skills"][0]["name"], "plugin-skill");
        assert!(second["nextOffset"].is_null());
        store.set_enabled("plugin-skill", false).unwrap();
        let disabled = SkillSearchTool
            .execute(&ctx, json!({"query": "plugin"}))
            .await
            .unwrap();
        assert_eq!(disabled["total"], 0);
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
