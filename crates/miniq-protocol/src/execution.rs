use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ApiProtocol, HistoryCursor, ReasoningEffort};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelExecutionInfo {
    pub model: String,
    pub api_protocol: ApiProtocol,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub max_output_tokens: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResponseInfo {
    pub model: Option<String>,
    pub response_id: Option<String>,
    /// Exact provider usage fields. Missing usage is unknown, never zero.
    pub usage: Option<Value>,
    pub stop_reason: Option<String>,
}

impl ProviderResponseInfo {
    /// Merge cumulative provider snapshots, retaining omitted fields without
    /// adding counters (reasoning tokens are already part of output tokens).
    pub fn merge(&mut self, update: Self) -> bool {
        let mut changed = false;
        for (target, incoming) in [
            (&mut self.model, update.model),
            (&mut self.response_id, update.response_id),
            (&mut self.stop_reason, update.stop_reason),
        ] {
            if incoming.is_some() && *target != incoming {
                *target = incoming;
                changed = true;
            }
        }
        if let Some(usage) = update.usage {
            changed |= merge_usage(self.usage.get_or_insert(Value::Null), usage);
        }
        changed
    }
}

fn merge_usage(target: &mut Value, incoming: Value) -> bool {
    if let (Value::Object(target), Value::Object(incoming)) = (&mut *target, &incoming) {
        let mut changed = false;
        for (key, value) in incoming {
            match target.get_mut(key) {
                Some(target) => changed |= merge_usage(target, value.clone()),
                None => {
                    target.insert(key.clone(), value.clone());
                    changed = true;
                }
            }
        }
        changed
    } else if *target != incoming {
        *target = incoming;
        true
    } else {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModelCallStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ModelCallPurpose {
    #[default]
    Task,
    Compaction,
    PlanReview,
    SkillLearning,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallTrace {
    pub purpose: ModelCallPurpose,
    pub step: Option<usize>,
    /// One-based request attempt, including retries of the same step.
    pub attempt: usize,
}

impl Default for ModelCallTrace {
    fn default() -> Self {
        Self {
            purpose: ModelCallPurpose::Task,
            step: None,
            attempt: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallRecord {
    pub id: String,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub turn_id: String,
    pub source_message_id: Option<String>,
    pub trace: ModelCallTrace,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub elapsed_ms: Option<u64>,
    pub status: ModelCallStatus,
    pub request: Option<ModelExecutionInfo>,
    pub estimated_input_tokens: usize,
    pub advertised_context_tokens: Option<u32>,
    pub advertised_output_tokens: Option<u32>,
    pub response: ProviderResponseInfo,
    pub error: Option<String>,
}

fn page_limit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let limit = u32::deserialize(deserializer)?;
    if !(1..=100).contains(&limit) {
        return Err(serde::de::Error::custom("limit must be between 1 and 100"));
    }
    Ok(limit)
}

fn default_limit() -> u32 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCallsParams {
    pub session_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub before: Option<HistoryCursor>,
    #[serde(default = "default_limit", deserialize_with = "page_limit")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelCallsPage {
    pub calls: Vec<ModelCallRecord>,
    pub next_cursor: Option<HistoryCursor>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pagination_schema_and_runtime_limits_agree() {
        let input: ModelCallsParams = serde_json::from_value(json!({"sessionId":"one"})).unwrap();
        assert_eq!(input.limit, 20);
        for limit in [0, 101] {
            assert!(serde_json::from_value::<ModelCallsParams>(
                json!({"sessionId":"one","limit":limit})
            )
            .is_err());
        }
        assert!(serde_json::from_value::<ModelCallsParams>(
            json!({"sessionId":"one","extra":true})
        )
        .is_err());
        let schema = serde_json::to_value(schemars::schema_for!(ModelCallsParams)).unwrap();
        assert_eq!(
            schema
                .pointer("/properties/limit/minimum")
                .and_then(Value::as_f64),
            Some(1.0)
        );
        assert_eq!(
            schema
                .pointer("/properties/limit/maximum")
                .and_then(Value::as_f64),
            Some(100.0)
        );
    }

    #[test]
    fn cumulative_usage_merges_fields_without_adding_tokens_or_losing_zeroes() {
        let mut info = ProviderResponseInfo::default();
        let update = ProviderResponseInfo {
            usage: Some(
                json!({"input_tokens":20, "output_tokens":0, "cache_creation":{"short":3}}),
            ),
            ..Default::default()
        };
        assert!(info.merge(update.clone()));
        assert!(!info.merge(update));
        assert!(info.merge(ProviderResponseInfo {
            usage: Some(json!({"output_tokens":10, "cache_creation":{"long":2}})),
            ..Default::default()
        }));
        assert_eq!(
            info.usage,
            Some(
                json!({"input_tokens":20,"output_tokens":10,"cache_creation":{"short":3,"long":2}})
            )
        );
        assert!(!info.merge(ProviderResponseInfo::default()));
    }
}
