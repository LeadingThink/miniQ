//! Staged feature flags persisted in `settings.json` (plan §4.7).
//!
//! Flags only gate *new* capabilities. Defaults never switch off anything
//! that already ships (connectors, hooks), and no flag participates in the
//! approval decision (`executor::approval::decide_approval`).

use serde::{Deserialize, Serialize};

/// Rollout stage of a feature.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeatureStage {
    #[default]
    Off,
    /// Visible only to internal / opt-in users.
    Internal,
    On,
}

impl FeatureStage {
    pub fn enabled(self) -> bool {
        self != FeatureStage::Off
    }
}

fn on() -> FeatureStage {
    FeatureStage::On
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureFlags {
    #[serde(default)]
    pub plugins_v2: FeatureStage,
    #[serde(default)]
    pub mcp_v2: FeatureStage,
    /// Existing capability: stays on unless explicitly disabled.
    #[serde(default = "on")]
    pub connectors: FeatureStage,
    #[serde(default)]
    pub mentions: FeatureStage,
    #[serde(default)]
    pub recommend_install: FeatureStage,
    /// Existing capability: stays on unless explicitly disabled.
    #[serde(default = "on")]
    pub hooks: FeatureStage,
    #[serde(default)]
    pub mcp_apps: FeatureStage,
}

impl Default for FeatureFlags {
    fn default() -> Self {
        Self {
            plugins_v2: FeatureStage::Off,
            mcp_v2: FeatureStage::Off,
            connectors: FeatureStage::On,
            mentions: FeatureStage::Off,
            recommend_install: FeatureStage::Off,
            hooks: FeatureStage::On,
            mcp_apps: FeatureStage::Off,
        }
    }
}

impl FeatureFlags {
    pub const COUNT: usize = 7;

    /// Mutable access in declaration order (used by exhaustive tests).
    pub fn stages_mut(&mut self) -> [&mut FeatureStage; Self::COUNT] {
        [
            &mut self.plugins_v2,
            &mut self.mcp_v2,
            &mut self.connectors,
            &mut self.mentions,
            &mut self.recommend_install,
            &mut self.hooks,
            &mut self.mcp_apps,
        ]
    }
}

/// Partial update accepted by `features.set`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeatureFlagsPatch {
    pub plugins_v2: Option<FeatureStage>,
    pub mcp_v2: Option<FeatureStage>,
    pub connectors: Option<FeatureStage>,
    pub mentions: Option<FeatureStage>,
    pub recommend_install: Option<FeatureStage>,
    pub hooks: Option<FeatureStage>,
    pub mcp_apps: Option<FeatureStage>,
}

impl FeatureFlagsPatch {
    pub fn apply(self, flags: &mut FeatureFlags) {
        let pairs = [
            (self.plugins_v2, &mut flags.plugins_v2),
            (self.mcp_v2, &mut flags.mcp_v2),
            (self.connectors, &mut flags.connectors),
            (self.mentions, &mut flags.mentions),
            (self.recommend_install, &mut flags.recommend_install),
            (self.hooks, &mut flags.hooks),
            (self.mcp_apps, &mut flags.mcp_apps),
        ];
        for (value, slot) in pairs {
            if let Some(value) = value {
                *slot = value;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_section_keeps_existing_features_on() {
        let settings: crate::state::DaemonSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.features, FeatureFlags::default());
        assert!(settings.features.connectors.enabled());
        assert!(settings.features.hooks.enabled());
        let partial: FeatureFlags = serde_json::from_str(r#"{"mentions":"internal"}"#).unwrap();
        assert_eq!(partial.mentions, FeatureStage::Internal);
        assert_eq!(partial.hooks, FeatureStage::On);
    }

    #[test]
    fn stages_serialize_lowercase() {
        let json = serde_json::to_value(FeatureFlags::default()).unwrap();
        assert_eq!(json["pluginsV2"], "off");
        assert_eq!(json["connectors"], "on");
        assert!(serde_json::from_str::<FeatureStage>(r#""On""#).is_err());
    }

    #[test]
    fn patch_only_touches_given_fields() {
        let mut flags = FeatureFlags::default();
        let patch: FeatureFlagsPatch =
            serde_json::from_str(r#"{"mcpApps":"on","hooks":"off"}"#).unwrap();
        patch.apply(&mut flags);
        assert_eq!(flags.mcp_apps, FeatureStage::On);
        assert_eq!(flags.hooks, FeatureStage::Off);
        assert_eq!(flags.connectors, FeatureStage::On);
        assert!(serde_json::from_str::<FeatureFlagsPatch>(r#"{"bogus":"on"}"#).is_err());
    }
}
