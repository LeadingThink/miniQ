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
    Skills,
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
    #[serde(default)]
    pub entry: PathBuf,
    pub capabilities: Vec<PluginCapability>,
    #[serde(default)]
    pub skills: Vec<PathBuf>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub engine: Option<PluginEngine>,
    /// WASM tools the author declares side-effect free (plan v3 §4.4, the
    /// API v1 form of `extensions."dev.miniq".nativeTools[].readOnly`).
    /// They are evaluated as Low risk instead of the Medium default.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_only_tools: Vec<String>,
    /// MCP servers (connectors) contributed while the plugin is enabled.
    /// Allowed for every runtime and needs no extra capability, so a
    /// `runtime = "skills"` pack can ship both skills and connectors.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<PluginMcpServer>,
}

/// One `[[mcp_servers]]` entry of a plugin manifest: a stdio MCP server the
/// daemon launches on demand.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PluginMcpServer {
    /// Globally visible server name (`^[a-z0-9][a-z0-9-]{0,39}$`).
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Names of daemon environment variables forwarded to the server when
    /// set (values never live in the manifest).
    #[serde(default)]
    pub env: Vec<String>,
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
    #[error("plugin capabilities do not match its runtime or skill directories")]
    UnsupportedCapability,
    #[error("permission is not implemented for this runtime in API v1: {0:?}")]
    UnsupportedPermission(PluginPermission),
    #[error("plugin entry must be a relative runtime-compatible path without traversal")]
    InvalidEntry,
    #[error("Node plugins must declare engine.node")]
    MissingNodeEngine,
    #[error("engine.node is only valid for Node plugins")]
    UnexpectedNodeEngine,
    #[error("read_only_tools is only valid for WASM plugins and must list tool names")]
    InvalidReadOnlyTools,
    #[error("invalid mcp_servers entry: {0}")]
    InvalidMcpServer(String),
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
        let has_tools = self.capabilities.contains(&PluginCapability::Tool);
        let has_skills = self.capabilities.contains(&PluginCapability::Skills);
        if self.capabilities.is_empty()
            || if self.runtime == PluginRuntime::Skills {
                self.capabilities != [PluginCapability::Skills] || self.skills.is_empty()
            } else {
                !has_tools || has_skills != !self.skills.is_empty()
            }
            || self.skills.iter().any(|path| !valid_relative(path))
            || self
                .requires
                .iter()
                .any(|name| name.is_empty() || name.contains(['/', '\\']))
        {
            return Err(ManifestError::UnsupportedCapability);
        }
        if !self.read_only_tools.is_empty()
            && (self.runtime != PluginRuntime::Wasm
                || self
                    .read_only_tools
                    .iter()
                    .any(|name| name.is_empty() || name.contains(['.', '/', '\\'])))
        {
            return Err(ManifestError::InvalidReadOnlyTools);
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
            PluginRuntime::Skills => {
                if self.engine.is_some()
                    || !self.entry.as_os_str().is_empty()
                    || !self.permissions.is_empty()
                {
                    return Err(ManifestError::InvalidEntry);
                }
            }
        }
        if self.runtime != PluginRuntime::Skills && !valid_entry(&self.entry, self.runtime) {
            return Err(ManifestError::InvalidEntry);
        }
        self.validate_mcp_servers()
    }

    fn validate_mcp_servers(&self) -> Result<(), ManifestError> {
        let mut seen = std::collections::BTreeSet::new();
        for server in &self.mcp_servers {
            if !valid_mcp_server_name(&server.name) {
                return Err(ManifestError::InvalidMcpServer(format!(
                    "name {:?} must match ^[a-z0-9][a-z0-9-]{{0,39}}$",
                    server.name
                )));
            }
            if !seen.insert(server.name.as_str()) {
                return Err(ManifestError::InvalidMcpServer(format!(
                    "duplicate server name {:?}",
                    server.name
                )));
            }
            if server.command.trim().is_empty() {
                return Err(ManifestError::InvalidMcpServer(format!(
                    "server {:?} has an empty command",
                    server.name
                )));
            }
            if let Some(name) = server.env.iter().find(|name| !valid_env_name(name)) {
                return Err(ManifestError::InvalidMcpServer(format!(
                    "server {:?} lists invalid environment variable name {name:?}",
                    server.name
                )));
            }
        }
        Ok(())
    }
}

/// `^[a-z0-9][a-z0-9-]{0,39}$`
pub(crate) fn valid_mcp_server_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// POSIX-portable environment variable name: `^[A-Za-z_][A-Za-z0-9_]*$`.
pub(crate) fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
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
        PluginRuntime::Skills => false,
    };
    extension_matches && valid_relative(entry)
}

pub(crate) fn valid_relative(entry: &Path) -> bool {
    !entry.as_os_str().is_empty()
        && !entry.is_absolute()
        && entry
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> PluginManifest {
        PluginManifest {
            id: "dev.miniq.fixture".into(),
            name: "Fixture".into(),
            version: Version::new(1, 0, 0),
            api_version: Version::new(1, 0, 0),
            runtime: PluginRuntime::Wasm,
            entry: "plugin.wasm".into(),
            capabilities: vec![PluginCapability::Tool],
            skills: Vec::new(),
            requires: Vec::new(),
            permissions: vec![PluginPermission::Log],
            enabled: true,
            description: None,
            author: None,
            engine: None,
            read_only_tools: Vec::new(),
            mcp_servers: Vec::new(),
        }
    }

    const SKILLS_WITH_MCP: &str = r#"
id = "dev.miniq.linear"
name = "Linear"
version = "1.0.0"
api_version = "1.0.0"
runtime = "skills"
capabilities = ["skills"]
skills = ["linear"]

[[mcp_servers]]
name = "linear"
description = "Linear issues"
command = "npx"
args = ["-y", "mcp-remote@latest", "https://mcp.linear.app/mcp"]
env = []

[[mcp_servers]]
name = "linear-2"
command = "linear-mcp"
env = ["LINEAR_API_KEY", "_X1"]
"#;

    #[test]
    fn parses_mcp_servers_on_skills_runtime() {
        let parsed = PluginManifest::parse(SKILLS_WITH_MCP).unwrap();
        assert_eq!(parsed.capabilities, vec![PluginCapability::Skills]);
        assert_eq!(parsed.mcp_servers.len(), 2);
        let linear = &parsed.mcp_servers[0];
        assert_eq!(linear.name, "linear");
        assert_eq!(linear.description.as_deref(), Some("Linear issues"));
        assert_eq!(linear.command, "npx");
        assert_eq!(linear.args.len(), 3);
        assert!(linear.env.is_empty());
        let second = &parsed.mcp_servers[1];
        assert!(second.args.is_empty());
        assert_eq!(second.env, vec!["LINEAR_API_KEY", "_X1"]);

        // Round-trips through the serializer used by set_enabled.
        let reparsed = PluginManifest::parse(&toml::to_string_pretty(&parsed).unwrap()).unwrap();
        assert_eq!(reparsed.mcp_servers, parsed.mcp_servers);
        // Manifests without connectors still serialize without the key.
        assert!(!toml::to_string_pretty(&manifest())
            .unwrap()
            .contains("mcp_servers"));
    }

    #[test]
    fn rejects_invalid_mcp_servers() {
        for (from, to) in [
            ("name = \"linear-2\"", "name = \"linear\""),
            ("name = \"linear-2\"", "name = \"Linear\""),
            ("name = \"linear-2\"", "name = \"-linear\""),
            ("name = \"linear-2\"", "name = \"\""),
            (
                "name = \"linear-2\"",
                "name = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
            ),
            ("name = \"linear-2\"", "name = \"lin_ear\""),
            ("\"_X1\"", "\"1ABC\""),
            ("\"_X1\"", "\"A-B\""),
            ("\"_X1\"", "\"A=B\""),
            ("command = \"linear-mcp\"", "command = \" \""),
        ] {
            let raw = SKILLS_WITH_MCP.replace(from, to);
            assert!(
                matches!(
                    PluginManifest::parse(&raw),
                    Err(ManifestError::InvalidMcpServer(_))
                ),
                "{to} should be rejected"
            );
        }
        let unknown = SKILLS_WITH_MCP.replace("env = []", "env = []\nurl = \"x\"");
        assert!(matches!(
            PluginManifest::parse(&unknown),
            Err(ManifestError::InvalidToml(_))
        ));
        let missing_command = SKILLS_WITH_MCP.replace("command = \"npx\"\n", "");
        assert!(matches!(
            PluginManifest::parse(&missing_command),
            Err(ManifestError::InvalidToml(_))
        ));
        // Longest valid name (40 chars) is accepted.
        let longest = SKILLS_WITH_MCP.replace(
            "name = \"linear-2\"",
            "name = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
        );
        assert!(PluginManifest::parse(&longest).is_ok());
    }

    #[test]
    fn read_only_tools_are_wasm_only() {
        let mut wasm = manifest();
        wasm.read_only_tools = vec!["count".into()];
        assert!(wasm.validate().is_ok());
        wasm.read_only_tools = vec!["other.count".into()];
        assert!(matches!(
            wasm.validate(),
            Err(ManifestError::InvalidReadOnlyTools)
        ));
        let parsed = PluginManifest::parse(
            r#"id = "dev.miniq.node-test"
name = "Test"
version = "1.0.0"
api_version = "1.0.0"
runtime = "node"
entry = "index.mjs"
capabilities = ["tool"]
read_only_tools = ["count"]

[engine]
node = ">=22"
"#,
        );
        assert!(matches!(parsed, Err(ManifestError::InvalidReadOnlyTools)));
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
    fn validates_versioned_skill_pack_contract() {
        let raw = r#"
id = "dev.miniq.docs"
name = "Document skills"
version = "2.1.0"
api_version = "1.0.0"
runtime = "skills"
capabilities = ["skills"]
skills = ["document-workflow", "pdf-workflow"]
requires = ["latexmk"]
"#;
        let parsed = PluginManifest::parse(raw).unwrap();
        assert_eq!(parsed.runtime, PluginRuntime::Skills);
        assert_eq!(parsed.skills.len(), 2);
        assert_eq!(parsed.requires, vec!["latexmk"]);

        let mut empty = parsed;
        empty.skills.clear();
        assert_eq!(empty.validate(), Err(ManifestError::UnsupportedCapability));
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
