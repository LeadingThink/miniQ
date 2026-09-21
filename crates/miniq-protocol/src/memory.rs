use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn non_empty<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Err(serde::de::Error::custom("value must not be empty"));
    }
    Ok(value)
}

/// Management addresses one exact scope. Agent search may combine project and global memory.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "scope", rename_all = "lowercase", deny_unknown_fields)]
pub enum MemoryTarget {
    Workspace {
        #[serde(rename = "workspaceId", deserialize_with = "non_empty")]
        #[schemars(length(min = 1))]
        workspace_id: String,
    },
    Global {},
}

impl MemoryTarget {
    pub fn parts(&self) -> (&'static str, Option<&str>) {
        match self {
            Self::Workspace { workspace_id } => ("workspace", Some(workspace_id)),
            Self::Global {} => ("global", None),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCursor {
    #[serde(deserialize_with = "non_empty")]
    #[schemars(length(min = 1))]
    pub updated_at: String,
    #[serde(deserialize_with = "non_empty")]
    #[schemars(length(min = 1))]
    pub id: String,
}

fn default_limit() -> u32 {
    20
}

fn page_limit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if !(1..=100).contains(&value) {
        return Err(serde::de::Error::custom("limit must be between 1 and 100"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryListParams {
    pub target: MemoryTarget,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub before: Option<MemoryCursor>,
    #[serde(default = "default_limit", deserialize_with = "page_limit")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryDeleteParams {
    pub target: MemoryTarget,
    #[serde(deserialize_with = "non_empty")]
    #[schemars(length(min = 1))]
    pub id: String,
    #[serde(deserialize_with = "non_empty")]
    #[schemars(length(min = 1))]
    pub expected_updated_at: String,
    /// Compare the displayed content too, even if its timestamp did not change.
    #[serde(deserialize_with = "non_empty")]
    #[schemars(length(min = 1))]
    pub expected_content: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn memory_management_requires_an_exact_scope_and_valid_limit() {
        for target in [
            json!({"scope":"workspace"}),
            json!({"scope":"workspace","workspaceId":""}),
            json!({"scope":"global","workspaceId":"other"}),
            json!({"scope":"all"}),
        ] {
            assert!(serde_json::from_value::<MemoryTarget>(target).is_err());
        }
        for limit in [json!(0), json!(101), json!(-1), json!(1.5), json!("20")] {
            assert!(serde_json::from_value::<MemoryListParams>(
                json!({"target":{"scope":"global"},"limit":limit})
            )
            .is_err());
        }
        let parsed: MemoryListParams =
            serde_json::from_value(json!({"target":{"scope":"global"}})).unwrap();
        assert_eq!(parsed.limit, 20);
        let schema = serde_json::to_value(schemars::schema_for!(MemoryListParams)).unwrap();
        assert_eq!(schema["properties"]["limit"]["minimum"].as_f64(), Some(1.0));
        assert_eq!(
            schema["properties"]["limit"]["maximum"].as_f64(),
            Some(100.0)
        );
        assert_eq!(schema["properties"]["limit"]["default"], 20);
        assert!(serde_json::from_value::<MemoryDeleteParams>(
            json!({"target":{"scope":"global"},"id":"m","expectedUpdatedAt":"now"})
        )
        .is_err());
        assert!(serde_json::from_value::<MemoryDeleteParams>(json!({"target":{"scope":"global"},"id":"m","expectedUpdatedAt":"now","expectedContent":"","extra":true})).is_err());
    }
}
