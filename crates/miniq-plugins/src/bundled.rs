//! First-party plugin packages compiled into the binary.
//!
//! They are ordinary `skills` runtime packages (no executable code) that the
//! manager materializes into the plugin directory, so they show up and behave
//! exactly like locally installed plugins, except that they cannot be
//! uninstalled (only disabled) and are upgraded automatically.

use std::collections::BTreeMap;

include!(concat!(env!("OUT_DIR"), "/bundled_plugins.rs"));

/// One bundled package: its id (directory name) and files keyed by the path
/// relative to the package directory.
#[derive(Debug, Clone)]
pub struct BundledPlugin {
    pub id: String,
    pub files: Vec<(String, &'static str)>,
}

/// All bundled packages, sorted by id.
pub fn bundled_plugins() -> Vec<BundledPlugin> {
    group(BUNDLED_FILES)
}

/// Whether `id` names a first-party plugin compiled into this binary.
pub fn is_bundled(id: &str) -> bool {
    BUNDLED_FILES.iter().any(|(path, _)| {
        path.split_once('/')
            .is_some_and(|(package, rest)| package == id && rest == "manifest.toml")
    })
}

pub(crate) fn group(files: &[(&str, &'static str)]) -> Vec<BundledPlugin> {
    let mut packages: BTreeMap<String, Vec<(String, &'static str)>> = BTreeMap::new();
    for (path, content) in files {
        let Some((id, relative)) = path.split_once('/') else {
            continue;
        };
        packages
            .entry(id.to_string())
            .or_default()
            .push((relative.to_string(), *content));
    }
    packages
        .into_iter()
        .map(|(id, files)| BundledPlugin { id, files })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::PluginManifest;
    use miniq_protocol::PluginRuntime;
    use std::collections::HashSet;

    #[test]
    fn bundled_packages_are_valid_skill_packages() {
        let packages = bundled_plugins();
        assert!(packages.len() >= 5, "expected bundled plugins");
        let mut skill_names = HashSet::new();
        for package in packages {
            let manifest = package
                .files
                .iter()
                .find(|(path, _)| path == "manifest.toml")
                .map(|(_, content)| *content)
                .unwrap_or_else(|| panic!("{} has no manifest.toml", package.id));
            let manifest = PluginManifest::parse(manifest).unwrap();
            manifest.validate().unwrap();
            assert_eq!(manifest.id, package.id);
            assert_eq!(manifest.runtime, PluginRuntime::Skills);
            assert!(!manifest.skills.is_empty());
            for skill in &manifest.skills {
                let skill_path = format!("{}/SKILL.md", skill.to_string_lossy());
                let raw = package
                    .files
                    .iter()
                    .find(|(path, _)| *path == skill_path)
                    .map(|(_, content)| *content)
                    .unwrap_or_else(|| panic!("{} missing {skill_path}", package.id));
                let (meta, _) = miniq_skills::parse_skill_md(raw)
                    .unwrap_or_else(|e| panic!("{} {skill_path}: {e:?}", package.id));
                assert_eq!(
                    Some(meta.name.as_str()),
                    skill.file_name().and_then(|name| name.to_str())
                );
                assert!(
                    skill_names.insert(meta.name.clone()),
                    "duplicate skill {}",
                    meta.name
                );
            }
        }
    }
}
