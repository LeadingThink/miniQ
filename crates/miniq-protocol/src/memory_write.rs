//! Shared memory contracts for RPC, tools and background extraction.
use crate::MemoryTarget;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if value.trim().is_empty() {
        return Err(serde::de::Error::custom(
            "text must contain a non-whitespace character",
        ));
    }
    Ok(value)
}
fn revision<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(d)?;
    if value == 0 {
        return Err(serde::de::Error::custom("revision must be positive"));
    }
    Ok(value)
}
fn optional_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(d)?;
    if value.as_ref().is_some_and(|v| v.trim().is_empty()) {
        return Err(serde::de::Error::custom("key must not be blank"));
    }
    Ok(value)
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Preference,
    #[default]
    Fact,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryReplacement {
    #[serde(deserialize_with = "text")]
    #[schemars(regex(pattern = r"\S"))]
    pub id: String,
    #[serde(deserialize_with = "revision")]
    #[schemars(range(min = 1, max = 4294967295u32))]
    pub expected_revision: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryWriteParams {
    pub target: MemoryTarget,
    #[serde(deserialize_with = "text")]
    #[schemars(regex(pattern = r"\S"))]
    pub content: String,
    #[serde(default)]
    pub kind: MemoryKind,
    /// Stable subject/attribute/condition key. Different conditions need different keys.
    #[serde(default, deserialize_with = "optional_text")]
    #[schemars(regex(pattern = r"\S"))]
    pub key: Option<String>,
    /// Explicitly identified correction; similarity never authorizes replacement.
    #[serde(default)]
    pub replaces: Option<MemoryReplacement>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryWriteStatus {
    Added,
    Updated,
    Unchanged,
    NeedsConfirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub workspace_id: Option<String>,
    pub scope: String,
    pub content: String,
    pub revision: u32,
    pub kind: MemoryKind,
    pub key: Option<String>,
    /// unknown for migrated records, explicit or extracted for new records.
    pub origin: String,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteResult {
    pub status: MemoryWriteStatus,
    pub memory: Option<MemoryRecord>,
    pub reason: Option<String>,
}
fn enabled() -> bool {
    true
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySettings {
    #[serde(default = "enabled")]
    pub recall_enabled: bool,
    /// Extract project facts and shared user preferences from future successful turns.
    #[serde(default)]
    pub auto_save: bool,
}
impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            recall_enabled: true,
            auto_save: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionMemorySettings {
    pub session_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryReadParams {
    pub target: MemoryTarget,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryProjectParams {
    pub source_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProjectSummary {
    pub session_id: String,
    pub session_status: crate::SessionStatus,
    pub title: String,
    pub goal: Option<crate::SessionGoal>,
    pub plan: Vec<crate::PlanTask>,
    pub decisions: Vec<MemoryRecord>,
    pub artifacts: Vec<crate::Artifact>,
    pub last_turn_outcome: Option<serde_json::Value>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    pub session_id: String,
    pub message_id: String,
    pub content_hash: String,
    pub byte_start: usize,
    pub byte_end: usize,
}

/// Extraction classifies scope without letting the model select another workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCandidateKind {
    /// A preference specific to the source project.
    Preference,
    Fact,
    Project,
    /// A durable personal preference that applies independently of this project.
    GlobalPreference,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCandidate {
    #[serde(deserialize_with = "text")]
    #[schemars(regex(pattern = r"\S"))]
    pub content: String,
    pub kind: MemoryCandidateKind,
    #[serde(deserialize_with = "text")]
    #[schemars(regex(pattern = r"\S"))]
    pub key: String,
    /// Verbatim supporting span in the source page; never model-generated evidence.
    #[serde(deserialize_with = "text")]
    #[schemars(regex(pattern = r"\S"))]
    pub evidence: String,
}

impl MemoryCandidate {
    pub fn write_params(&self, workspace_id: &str) -> MemoryWriteParams {
        let target = if self.kind == MemoryCandidateKind::GlobalPreference {
            MemoryTarget::Global {}
        } else {
            MemoryTarget::Workspace {
                workspace_id: workspace_id.into(),
            }
        };
        let kind = match self.kind {
            MemoryCandidateKind::GlobalPreference | MemoryCandidateKind::Preference => {
                MemoryKind::Preference
            }
            MemoryCandidateKind::Fact => MemoryKind::Fact,
            MemoryCandidateKind::Project => MemoryKind::Project,
        };
        MemoryWriteParams {
            target,
            content: self.content.clone(),
            kind,
            key: Some(self.key.clone()),
            replaces: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn memory_write_contract_rejects_blank_keys_and_incomplete_corrections() {
        let base = json!({"target":{"scope":"global"},"content":"偏好中文"});
        for patch in [
            json!({"key":" "}),
            json!({"content":"\n"}),
            json!({"kind":"todo"}),
            json!({"replaces":{"id":"m"}}),
            json!({"replaces":{"id":"m","expectedRevision":0}}),
            json!({"replaces":{"id":"m","expectedRevision":4294967296u64}}),
        ] {
            let mut value = base.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(serde_json::from_value::<MemoryWriteParams>(value).is_err());
        }
        let schema = serde_json::to_value(schemars::schema_for!(MemoryWriteParams)).unwrap();
        assert_eq!(schema["properties"]["content"]["pattern"], r"\S");
        assert_eq!(
            schema["definitions"]["MemoryReplacement"]["properties"]["expectedRevision"]["minimum"],
            1.0
        );
        assert_eq!(
            serde_json::from_value::<MemoryWriteParams>(base)
                .unwrap()
                .kind,
            MemoryKind::Fact
        );
    }
    #[test]
    fn memory_settings_defaults_never_grant_automatic_saving() {
        assert_eq!(
            serde_json::from_value::<MemorySettings>(json!({})).unwrap(),
            MemorySettings::default()
        );
        let schema = serde_json::to_value(schemars::schema_for!(MemorySettings)).unwrap();
        assert_eq!(schema["properties"]["autoSave"]["default"], false);
    }

    #[test]
    fn memory_candidates_derive_scope_from_a_closed_classification() {
        for (kind, scope, stored_kind) in [
            ("preference", "workspace", MemoryKind::Preference),
            ("fact", "workspace", MemoryKind::Fact),
            ("project", "workspace", MemoryKind::Project),
            ("global_preference", "global", MemoryKind::Preference),
        ] {
            let candidate: MemoryCandidate = serde_json::from_value(json!({
                "content":"用户习惯先看结论", "kind":kind,
                "key":"user.explanation.order", "evidence":"我习惯先看结论"
            }))
            .unwrap();
            let params = candidate.write_params("source-workspace");
            assert_eq!(params.target.parts().0, scope);
            assert_eq!(
                params.target.parts().1,
                (scope == "workspace").then_some("source-workspace")
            );
            assert_eq!(params.kind, stored_kind);
            assert!(params.replaces.is_none());
        }
        let base = json!({"content":"用户习惯先看结论", "kind":"global_preference",
            "key":"user.explanation.order", "evidence":"我习惯先看结论"});
        for patch in [
            json!({"kind":"global_fact"}),
            json!({"workspaceId":"other"}),
            json!({"target":{"scope":"global"}}),
            json!({"evidence":" "}),
        ] {
            let mut invalid = base.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(serde_json::from_value::<MemoryCandidate>(invalid).is_err());
        }
        let schema = serde_json::to_value(schemars::schema_for!(MemoryCandidate)).unwrap();
        let kinds = schema["definitions"]["MemoryCandidateKind"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|variant| variant["enum"].as_array().unwrap())
            .map(|value| value.as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            kinds,
            std::collections::BTreeSet::from([
                "preference",
                "fact",
                "project",
                "global_preference"
            ])
        );
        assert_eq!(schema["additionalProperties"], false);
    }
}
