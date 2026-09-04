//! Searchable tool catalog used by native ToolSearch calls.

use async_trait::async_trait;
use miniq_models::ToolSpec;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::native::{canonical_name, native_aliases};
use crate::router::{parse_input, Tool, ToolContext, ToolError};

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;

pub struct ToolSearchTool {
    catalog: Vec<ToolSpec>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolSearchInput {
    #[serde(default)]
    query: String,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
}

impl ToolSearchTool {
    pub fn new(mut catalog: Vec<ToolSpec>) -> Self {
        catalog.push(Self::tool_spec());
        catalog.sort_by(|left, right| left.name.cmp(&right.name));
        Self { catalog }
    }

    pub fn tool_spec() -> ToolSpec {
        ToolSpec {
            name: "tool_search".into(),
            description: "Search miniQ's current tool catalog and return full JSON schemas. Supports exact native-name selection with `select:name,name`.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text query, or select:ToolA,ToolB for exact selection"},
                    "offset": {"type": "integer", "minimum": 0},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT}
                }
            }),
        }
    }

    fn selected(&self, query: &str) -> Option<Vec<&ToolSpec>> {
        let names = query.strip_prefix("select:")?;
        let requested = names
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>();
        Some(
            self.catalog
                .iter()
                .filter(|spec| {
                    requested.iter().any(|name| {
                        *name == spec.name || canonical_name(name) == Some(spec.name.as_str())
                    })
                })
                .collect(),
        )
    }

    fn searched(&self, query: &str) -> Vec<&ToolSpec> {
        let words = query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        self.catalog
            .iter()
            .filter(|spec| {
                if words.is_empty() {
                    return true;
                }
                let aliases = native_aliases(&spec.name).join(" ").to_lowercase();
                let haystack = format!(
                    "{} {} {aliases}",
                    spec.name.to_lowercase(),
                    spec.description.to_lowercase()
                );
                words.iter().all(|word| haystack.contains(word))
            })
            .collect()
    }
}

#[async_trait]
impl Tool for ToolSearchTool {
    fn name(&self) -> &str {
        "tool_search"
    }

    fn description(&self) -> &str {
        "Search miniQ's current tool catalog and return complete JSON schemas."
    }

    fn parameters_schema(&self) -> Value {
        Self::tool_spec().parameters
    }

    fn evaluate_risk(&self, _ctx: &ToolContext, _input: &Value) -> Risk {
        Risk {
            level: RiskLevel::Low,
            reason: "read-only tool catalog search".into(),
        }
    }

    async fn execute(&self, _ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: ToolSearchInput = parse_input(input)?;
        if input
            .limit
            .is_some_and(|limit| !(1..=MAX_LIMIT).contains(&limit))
        {
            return Err(ToolError::InvalidInput(
                "limit must be between 1 and 100".into(),
            ));
        }
        let matches = self
            .selected(input.query.trim())
            .unwrap_or_else(|| self.searched(input.query.trim()));
        let total = matches.len();
        let limit = input.limit.unwrap_or(DEFAULT_LIMIT);
        let tools = matches
            .into_iter()
            .skip(input.offset)
            .take(limit)
            .map(|spec| {
                json!({
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.parameters,
                    "nativeAliases": native_aliases(&spec.name),
                })
            })
            .collect::<Vec<_>>();
        let next_offset = input.offset + tools.len();
        Ok(json!({
            "query": input.query,
            "tools": tools,
            "total": total,
            "offset": input.offset,
            "nextOffset": (next_offset < total).then_some(next_offset),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exact_select_resolves_native_names_and_returns_schemas() {
        let catalog = vec![ToolSpec {
            name: "file_read".into(),
            description: "Read files".into(),
            parameters: json!({"type":"object"}),
        }];
        let output = ToolSearchTool::new(catalog)
            .execute(
                &ToolContext::new(".".into()),
                json!({"query":"select:Read,ToolSearch"}),
            )
            .await
            .unwrap();
        assert_eq!(output["total"], 2);
        assert_eq!(output["tools"][0]["name"], "file_read");
        assert_eq!(output["tools"][1]["name"], "tool_search");
    }

    #[tokio::test]
    async fn search_is_paginated_without_silent_loss() {
        let catalog = (0..3)
            .map(|index| ToolSpec {
                name: format!("demo_{index}"),
                description: "demo".into(),
                parameters: json!({"type":"object"}),
            })
            .collect();
        let output = ToolSearchTool::new(catalog)
            .execute(
                &ToolContext::new(".".into()),
                json!({"query":"demo","limit":2}),
            )
            .await
            .unwrap();
        assert_eq!(output["total"], 3);
        assert_eq!(output["tools"].as_array().unwrap().len(), 2);
        assert_eq!(output["nextOffset"], 2);
    }
}
