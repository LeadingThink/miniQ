use std::path::{Component, Path, PathBuf};

use miniq_protocol::PluginRuntime;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const API_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginCapability {
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermission {
    Log,
    WorkspaceRead,
    WorkspaceWrite,
    HttpClient,
    MemoryRead,
    MemoryWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginEngine {
    pub node: VersionReq,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: Version,
    pub api_version: Version,
    pub runtime: PluginRuntime,
    pub entry: PathBuf,
    pub capabilities: Vec<PluginCapability>,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub description: Option<String>,
    pub author: Option<String>,
    pub engine: Option<PluginEngine>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("manifest TOML is invalid: {0}")]
    InvalidToml(String),
    #[error("plugin id must be a reverse-domain identifier")]
    InvalidId,
    #[error("plugin name must not be empty")]
    EmptyName,
    #[error("unsupported API version: {0}")]
    UnsupportedApiVersion(Version),
    #[error("plugin must declare exactly the tool capability")]
    UnsupportedCapability,
    #[error("permission is not implemented for this runtime in API v1: {0:?}")]
    UnsupportedPermission(PluginPermission),
    #[error("plugin entry must be a relative runtime-compatible path without traversal")]
    InvalidEntry,
    #[error("Node plugins must declare engine.node")]
    MissingNodeEngine,
    #[error("engine.node is only valid for Node plugins")]
    UnexpectedNodeEngine,
}

impl PluginManifest {
    pub fn parse(raw: &str) -> Result<Self, ManifestError> {
        let document: toml::Value =
            toml::from_str(raw).map_err(|error| ManifestError::InvalidToml(error.to_string()))?;
        let enabled_was_declared = document.get("enabled").is_some();
        let mut manifest: Self = document
            .try_into()
            .map_err(|error: toml::de::Error| ManifestError::InvalidToml(error.to_string()))?;
        if manifest.runtime == PluginRuntime::Node && !enabled_was_declared {
            manifest.enabled = false;
        }
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), ManifestError> {
        if !valid_plugin_id(&self.id) {
            return Err(ManifestError::InvalidId);
        }
        if self.name.trim().is_empty() {
            return Err(ManifestError::EmptyName);
        }
        if self.api_version != Version::parse(API_VERSION).unwrap() {
            return Err(ManifestError::UnsupportedApiVersion(
                self.api_version.clone(),
            ));
        }
        if self.capabilities != [PluginCapability::Tool] {
            return Err(ManifestError::UnsupportedCapability);
        }
        match self.runtime {
            PluginRuntime::Wasm => {
                if self.engine.is_some() {
                    return Err(ManifestError::UnexpectedNodeEngine);
                }
                if let Some(permission) = self
                    .permissions
                    .iter()
                    .find(|permission| **permission != PluginPermission::Log)
                {
                    return Err(ManifestError::UnsupportedPermission(permission.clone()));
                }
            }
            PluginRuntime::Node if self.engine.is_none() => {
                return Err(ManifestError::MissingNodeEngine);
            }
            PluginRuntime::Node => {}
        }
        if !valid_entry(&self.entry, self.runtime) {
            return Err(ManifestError::InvalidEntry);
        }
        Ok(())
    }
}

fn valid_plugin_id(id: &str) -> bool {
    let parts = id.split('.').collect::<Vec<_>>();
    parts.len() >= 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_lowercase())
                && part.chars().all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
                })
                && !part.ends_with('-')
        })
}

fn valid_entry(entry: &Path, runtime: PluginRuntime) -> bool {
    let extension_matches = match runtime {
        PluginRuntime::Wasm => entry
            .extension()
            .is_some_and(|extension| extension == "wasm"),
        PluginRuntime::Node => entry
            .extension()
            .is_some_and(|extension| extension == "js" || extension == "mjs"),
    };
    !entry.as_os_str().is_empty()
        && !entry.is_absolute()
        && extension_matches
        && entry
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> PluginManifest {
        PluginManifest {
            id: "dev.miniq.text-stats".into(),
            name: "Text Stats".into(),
            version: Version::new(1, 0, 0),
            api_version: Version::new(1, 0, 0),
            runtime: PluginRuntime::Wasm,
            entry: "plugin.wasm".into(),
            capabilities: vec![PluginCapability::Tool],
            permissions: vec![PluginPermission::Log],
            enabled: true,
            description: None,
            author: None,
            engine: None,
        }
    }

    #[test]
    fn validates_manifest_contract() {
        assert!(manifest().validate().is_ok());

        let mut invalid = manifest();
        invalid.id = "text_stats".into();
        assert_eq!(invalid.validate(), Err(ManifestError::InvalidId));

        let mut invalid = manifest();
        invalid.api_version = Version::new(2, 0, 0);
        assert!(matches!(
            invalid.validate(),
            Err(ManifestError::UnsupportedApiVersion(_))
        ));

        let mut invalid = manifest();
        invalid.entry = "../plugin.wasm".into();
        assert_eq!(invalid.validate(), Err(ManifestError::InvalidEntry));

        let mut invalid = manifest();
        invalid.permissions.push(PluginPermission::HttpClient);
        assert_eq!(
            invalid.validate(),
            Err(ManifestError::UnsupportedPermission(
                PluginPermission::HttpClient
            ))
        );
    }

    #[test]
    fn parse_rejects_invalid_semver() {
        let raw = r#"
id = "dev.miniq.test"
name = "Test"
version = "latest"
api_version = "1.0.0"
runtime = "wasm"
entry = "plugin.wasm"
capabilities = ["tool"]
"#;
        assert!(matches!(
            PluginManifest::parse(raw),
            Err(ManifestError::InvalidToml(_))
        ));
    }

    #[test]
    fn validates_node_runtime_contract() {
        let mut node = manifest();
        node.runtime = PluginRuntime::Node;
        node.entry = "dist/index.js".into();
        node.engine = Some(PluginEngine {
            node: VersionReq::parse(">=22").unwrap(),
        });
        node.permissions = vec![PluginPermission::WorkspaceRead];
        assert!(node.validate().is_ok());

        node.entry = "../index.js".into();
        assert_eq!(node.validate(), Err(ManifestError::InvalidEntry));

        node.entry = "dist/index.ts".into();
        assert_eq!(node.validate(), Err(ManifestError::InvalidEntry));
    }

    #[test]
    fn node_plugins_default_to_disabled() {
        let raw = r#"
id = "dev.miniq.node-test"
name = "Node Test"
version = "1.0.0"
api_version = "1.0.0"
runtime = "node"
entry = "index.mjs"
capabilities = ["tool"]

[engine]
node = ">=22"
"#;

        assert!(!PluginManifest::parse(raw).unwrap().enabled);
    }
}
