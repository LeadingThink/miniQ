//! Persistent "always allow" approval rules (plan v3 §4.3).
//!
//! Rules live in `<data_dir>/approvals/rules.json` (`schema_version = 1`).
//! Every rule is keyed by an [`ApprovalBinding`]; when any binding field of the
//! running tool differs from the stored one the rule stops matching and is
//! marked stale instead of being migrated. Writes are atomic (temp file +
//! rename) and serialized with an advisory lock on `rules.json.lock`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SCHEMA_VERSION: u32 = 1;

/// Identity of a tool that an "always allow" rule is bound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalBinding {
    /// `builtin:<tool>` or `plugin:<plugin id>/<tool>`; rules are stored by origin.
    pub origin: String,
    /// Where the tool came from (builtin, local plugin dir, marketplace, ...).
    pub source_id: String,
    /// Signing key fingerprint; `None` for unsigned sources.
    pub signer: Option<String>,
    /// Runtime / transport fingerprint (plugin runtime, MCP URL or command hash).
    pub transport_fingerprint: String,
    /// sha256 of tool description + input schema.
    pub desc_hash: String,
    /// Plugin major version; `None` for non-plugin tools.
    pub plugin_major: Option<u64>,
}

impl ApprovalBinding {
    /// Name of the first field that differs from `other`, if any.
    pub fn first_difference(&self, other: &ApprovalBinding) -> Option<&'static str> {
        if self.origin != other.origin {
            Some("origin")
        } else if self.source_id != other.source_id {
            Some("sourceId")
        } else if self.signer != other.signer {
            Some("signer")
        } else if self.transport_fingerprint != other.transport_fingerprint {
            Some("transportFingerprint")
        } else if self.desc_hash != other.desc_hash {
            Some("descHash")
        } else if self.plugin_major != other.plugin_major {
            Some("pluginMajor")
        } else {
            None
        }
    }
}

/// Hash of the tool description and input schema.
pub fn desc_hash(description: &str, schema: &serde_json::Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(description.as_bytes());
    hasher.update([0]);
    hasher.update(schema.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Major component of a semver-ish version string.
pub fn major_version(version: &str) -> Option<u64> {
    version
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .next()?
        .parse()
        .ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRule {
    pub id: String,
    pub tool: String,
    pub binding: ApprovalBinding,
    pub created_at: u64,
    pub created_by: String,
    /// Why the rule no longer matches (`None` while valid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RulesFile {
    schema_version: u32,
    #[serde(default)]
    rules: Vec<ApprovalRule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleMatch {
    Allowed,
    /// A rule exists for this origin but a binding field changed.
    Stale(&'static str),
    None,
}

pub struct ApprovalRules {
    path: Option<PathBuf>,
    /// In-memory copy; also used alone when no data dir is configured.
    cache: Mutex<Option<Vec<ApprovalRule>>>,
}

impl ApprovalRules {
    pub fn new(data_dir: Option<&Path>) -> Self {
        Self {
            path: data_dir.map(|dir| dir.join("approvals").join("rules.json")),
            cache: Mutex::new(None),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn list(&self) -> Vec<ApprovalRule> {
        let mut cache = self.cache.lock().unwrap();
        self.loaded(&mut cache).clone()
    }

    /// Checks `binding` against the stored rules. A mismatching rule for the
    /// same origin is marked stale and persisted.
    pub fn check(&self, binding: &ApprovalBinding) -> RuleMatch {
        let mut cache = self.cache.lock().unwrap();
        let rules = self.loaded(&mut cache);
        let mut result = RuleMatch::None;
        let mut changed = false;
        for rule in rules
            .iter_mut()
            .filter(|r| r.binding.origin == binding.origin)
        {
            match rule.binding.first_difference(binding) {
                None if rule.stale_reason.is_none() => return RuleMatch::Allowed,
                None => {}
                Some(field) => {
                    if rule.stale_reason.is_none() {
                        rule.stale_reason = Some(format!("{field} changed"));
                        changed = true;
                    }
                    result = RuleMatch::Stale(field);
                }
            }
        }
        if changed {
            let snapshot = rules.clone();
            self.persist(&snapshot);
        }
        result
    }

    /// Adds (or replaces) the rule for `binding.origin`.
    pub fn allow(&self, tool: &str, binding: ApprovalBinding, created_by: &str) -> ApprovalRule {
        let mut cache = self.cache.lock().unwrap();
        let rules = self.loaded(&mut cache);
        rules.retain(|rule| rule.binding.origin != binding.origin);
        let rule = ApprovalRule {
            id: format!("rule-{}", uuid::Uuid::new_v4().simple()),
            tool: tool.to_string(),
            binding,
            created_at: now_millis(),
            created_by: created_by.to_string(),
            stale_reason: None,
        };
        rules.push(rule.clone());
        let snapshot = rules.clone();
        self.persist(&snapshot);
        rule
    }

    /// Removes a rule; returns whether it existed.
    pub fn revoke(&self, id: &str) -> bool {
        let mut cache = self.cache.lock().unwrap();
        let rules = self.loaded(&mut cache);
        let before = rules.len();
        rules.retain(|rule| rule.id != id);
        let removed = rules.len() != before;
        if removed {
            let snapshot = rules.clone();
            self.persist(&snapshot);
        }
        removed
    }

    fn loaded<'a>(&self, cache: &'a mut Option<Vec<ApprovalRule>>) -> &'a mut Vec<ApprovalRule> {
        cache.get_or_insert_with(|| self.read_file())
    }

    fn read_file(&self) -> Vec<ApprovalRule> {
        let Some(path) = &self.path else {
            return Vec::new();
        };
        let Ok(text) = fs::read_to_string(path) else {
            return Vec::new();
        };
        match serde_json::from_str::<RulesFile>(&text) {
            Ok(file) if file.schema_version == SCHEMA_VERSION => file.rules,
            Ok(file) => {
                tracing::warn!(
                    "ignoring approval rules with unsupported schema_version {}",
                    file.schema_version
                );
                Vec::new()
            }
            Err(error) => {
                tracing::warn!("ignoring unreadable approval rules: {error}");
                Vec::new()
            }
        }
    }

    fn persist(&self, rules: &[ApprovalRule]) {
        let Some(path) = &self.path else {
            return;
        };
        if let Err(error) = write_locked(path, rules) {
            tracing::warn!("failed to save approval rules: {error}");
        }
    }
}

fn write_locked(path: &Path, rules: &[ApprovalRule]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("rules.json.lock"))?;
    lock.lock()?;
    let body = serde_json::to_vec_pretty(&RulesFile {
        schema_version: SCHEMA_VERSION,
        rules: rules.to_vec(),
    })
    .map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("rules.json.{}.tmp", std::process::id()));
    {
        let mut file = File::create(&tmp)?;
        file.write_all(&body)?;
        file.sync_all()?;
    }
    let result = fs::rename(&tmp, path);
    let _ = lock.unlock();
    result
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> ApprovalBinding {
        ApprovalBinding {
            origin: "plugin:demo/echo".into(),
            source_id: "local:demo".into(),
            signer: None,
            transport_fingerprint: "wasm".into(),
            desc_hash: desc_hash("echo", &serde_json::json!({"type": "object"})),
            plugin_major: Some(1),
        }
    }

    #[test]
    fn allow_persists_and_matches() {
        let dir = tempfile::tempdir().unwrap();
        let rules = ApprovalRules::new(Some(dir.path()));
        rules.allow("echo", binding(), "local");
        let reloaded = ApprovalRules::new(Some(dir.path()));
        assert_eq!(reloaded.check(&binding()), RuleMatch::Allowed);
        let text = fs::read_to_string(dir.path().join("approvals/rules.json")).unwrap();
        assert!(text.contains("\"schema_version\": 1"));
    }

    /// Plan v3 §4.3: changing any one of the six binding fields invalidates the rule.
    #[test]
    fn every_binding_field_invalidates_the_rule() {
        type Mutation = (&'static str, fn(&mut ApprovalBinding));
        let mutations: [Mutation; 6] = [
            ("origin", |b| b.origin = "plugin:other/echo".into()),
            ("sourceId", |b| b.source_id = "marketplace:x".into()),
            ("signer", |b| b.signer = Some("ed25519:abc".into())),
            ("transportFingerprint", |b| {
                b.transport_fingerprint = "node".into()
            }),
            ("descHash", |b| {
                b.desc_hash = desc_hash("echo v2", &serde_json::json!({}))
            }),
            ("pluginMajor", |b| b.plugin_major = Some(2)),
        ];
        for (field, mutate) in mutations {
            let dir = tempfile::tempdir().unwrap();
            let rules = ApprovalRules::new(Some(dir.path()));
            rules.allow("echo", binding(), "local");
            let mut changed = binding();
            mutate(&mut changed);
            let result = rules.check(&changed);
            if field == "origin" {
                assert_eq!(result, RuleMatch::None, "{field}");
            } else {
                assert_eq!(result, RuleMatch::Stale(field), "{field}");
                // Stays stale even when the old binding comes back.
                assert_eq!(rules.check(&binding()), RuleMatch::None, "{field}");
                let stored = ApprovalRules::new(Some(dir.path())).list();
                assert_eq!(
                    stored[0].stale_reason.as_deref(),
                    Some(&*format!("{field} changed"))
                );
            }
        }
    }

    #[test]
    fn revoke_removes_rule() {
        let dir = tempfile::tempdir().unwrap();
        let rules = ApprovalRules::new(Some(dir.path()));
        let rule = rules.allow("echo", binding(), "local");
        assert!(rules.revoke(&rule.id));
        assert!(!rules.revoke(&rule.id));
        assert_eq!(
            ApprovalRules::new(Some(dir.path())).check(&binding()),
            RuleMatch::None
        );
    }

    #[test]
    fn unknown_schema_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("approvals")).unwrap();
        fs::write(
            dir.path().join("approvals/rules.json"),
            r#"{"schema_version":9,"rules":[]}"#,
        )
        .unwrap();
        assert!(ApprovalRules::new(Some(dir.path())).list().is_empty());
    }

    #[test]
    fn major_version_parses() {
        assert_eq!(major_version("1.2.3"), Some(1));
        assert_eq!(major_version("v2.0.0-beta"), Some(2));
        assert_eq!(major_version("x"), None);
    }
}
