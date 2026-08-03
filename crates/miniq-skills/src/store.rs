//! Skill discovery and storage.
//!
//! Roots in priority order (same name: higher shadows lower):
//! 1. `<workspace>/.miniq/skills/` — project skills
//! 2. `<data_dir>/skills/`         — user global skills (incl. distilled)
//! 3. bundled                      — compiled into the binary
//!
//! Enabled/disabled state lives in `<data_dir>/skills-state.json`, not in
//! the SKILL.md, so toggling never rewrites user files.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use thiserror::Error;

use crate::parse::{parse_skill_md, ParseError, SkillMeta};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("skill not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse error in {path}: {source}")]
    Parse {
        path: String,
        #[source]
        source: ParseError,
    },
    #[error("{0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Project,
    User,
    Bundled,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    #[serde(flatten)]
    pub meta: SkillMeta,
    pub source: SkillSource,
    pub enabled: bool,
    /// Directory on disk; `None` for bundled skills not yet materialized.
    #[serde(skip)]
    pub dir: Option<PathBuf>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub skill: Skill,
    pub body: String,
    /// Workspace-relative sidecar files (scripts/templates/references).
    pub files: Vec<String>,
    /// Absolute skill directory for script execution, when on disk.
    pub skill_dir: Option<String>,
}

/// A skill compiled into the binary.
pub struct BundledSkill {
    pub content: &'static str,
}

pub struct SkillStore {
    /// User-global skills root (also receives distilled skills).
    user_root: PathBuf,
    /// State file with the disabled set.
    state_path: PathBuf,
    bundled: Vec<BundledSkill>,
    disabled: Mutex<HashSet<String>>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct SkillState {
    #[serde(default)]
    disabled: Vec<String>,
}

impl SkillStore {
    pub fn new(data_dir: &Path, bundled: Vec<BundledSkill>) -> Self {
        let state_path = data_dir.join("skills-state.json");
        let disabled: HashSet<String> = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<SkillState>(&raw).ok())
            .map(|s| s.disabled.into_iter().collect())
            .unwrap_or_default();
        Self {
            user_root: data_dir.join("skills"),
            state_path,
            bundled,
            disabled: Mutex::new(disabled),
        }
    }

    pub fn user_root(&self) -> &Path {
        &self.user_root
    }

    /// Discover all skills visible for a workspace, applying shadowing.
    /// Invalid skill dirs are skipped (logged upstream), never fatal.
    pub fn discover(&self, workspace: Option<&Path>) -> Vec<Skill> {
        let mut by_name: HashMap<String, Skill> = HashMap::new();
        let disabled = self.disabled.lock().unwrap();

        // Lowest priority first; later inserts overwrite (shadow) earlier.
        for bundled in &self.bundled {
            if let Ok((meta, _)) = parse_skill_md(bundled.content) {
                let enabled = !disabled.contains(&meta.name);
                by_name.insert(
                    meta.name.clone(),
                    Skill {
                        meta,
                        source: SkillSource::Bundled,
                        enabled,
                        dir: None,
                    },
                );
            }
        }
        for skill in scan_root(&self.user_root, SkillSource::User) {
            let enabled = !disabled.contains(&skill.meta.name);
            by_name.insert(skill.meta.name.clone(), Skill { enabled, ..skill });
        }
        if let Some(ws) = workspace {
            let project_root = ws.join(".miniq").join("skills");
            for skill in scan_root(&project_root, SkillSource::Project) {
                let enabled = !disabled.contains(&skill.meta.name);
                by_name.insert(skill.meta.name.clone(), Skill { enabled, ..skill });
            }
        }

        let mut skills: Vec<Skill> = by_name.into_values().collect();
        skills.sort_by(|a, b| a.meta.name.cmp(&b.meta.name));
        skills
    }

    fn find(&self, workspace: Option<&Path>, name: &str) -> Result<Skill, StoreError> {
        self.discover(workspace)
            .into_iter()
            .find(|s| s.meta.name == name)
            .ok_or_else(|| StoreError::NotFound(name.to_string()))
    }

    /// Full detail: body + sidecar file list.
    pub fn read(&self, workspace: Option<&Path>, name: &str) -> Result<SkillDetail, StoreError> {
        let skill = self.find(workspace, name)?;
        match &skill.dir {
            Some(dir) => {
                let raw = std::fs::read_to_string(dir.join("SKILL.md"))?;
                let (_, body) = parse_skill_md(&raw).map_err(|e| StoreError::Parse {
                    path: dir.join("SKILL.md").to_string_lossy().to_string(),
                    source: e,
                })?;
                let files = list_sidecar_files(dir);
                Ok(SkillDetail {
                    skill_dir: Some(dir.to_string_lossy().to_string()),
                    skill,
                    body,
                    files,
                })
            }
            None => {
                // Bundled, in-memory.
                let content = self
                    .bundled
                    .iter()
                    .find_map(|b| {
                        let (meta, _) = parse_skill_md(b.content).ok()?;
                        (meta.name == name).then_some(b.content)
                    })
                    .ok_or_else(|| StoreError::NotFound(name.to_string()))?;
                let (_, body) = parse_skill_md(content).map_err(|e| StoreError::Parse {
                    path: format!("bundled:{name}"),
                    source: e,
                })?;
                Ok(SkillDetail {
                    skill,
                    body,
                    files: Vec::new(),
                    skill_dir: None,
                })
            }
        }
    }

    /// Save (create or overwrite) a skill in the user root. `content` must
    /// be a full SKILL.md; it is validated with the same parser used for
    /// loading, so a saved skill is guaranteed discoverable.
    pub fn save(&self, content: &str) -> Result<SkillMeta, StoreError> {
        let (meta, _) = parse_skill_md(content).map_err(|e| StoreError::Parse {
            path: "<new skill>".to_string(),
            source: e,
        })?;
        let dir = self.user_root.join(&meta.name);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), content)?;
        Ok(meta)
    }

    /// Delete a skill from the user root. Project and bundled skills cannot
    /// be deleted through the store (project skills belong to the repo;
    /// bundled ones can only be disabled).
    pub fn delete(&self, workspace: Option<&Path>, name: &str) -> Result<(), StoreError> {
        let skill = self.find(workspace, name)?;
        if skill.source != SkillSource::User {
            return Err(StoreError::Invalid(format!(
                "only user skills can be deleted; {name} is {:?}",
                skill.source
            )));
        }
        let dir = skill.dir.expect("user skills are on disk");
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    pub fn set_enabled(&self, name: &str, enabled: bool) -> Result<(), StoreError> {
        let mut disabled = self.disabled.lock().unwrap();
        if enabled {
            disabled.remove(name);
        } else {
            disabled.insert(name.to_string());
        }
        let state = SkillState {
            disabled: disabled.iter().cloned().collect(),
        };
        if let Some(parent) = self.state_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(
            &self.state_path,
            serde_json::to_string_pretty(&state).unwrap(),
        )?;
        Ok(())
    }
}

fn scan_root(root: &Path, source: SkillSource) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // Refuse symlinked skill dirs (guard against escaping the root).
        if std::fs::symlink_metadata(&dir)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let md_path = dir.join("SKILL.md");
        let Ok(raw) = std::fs::read_to_string(&md_path) else {
            continue;
        };
        let Ok((meta, _)) = parse_skill_md(&raw) else {
            continue;
        };
        // Directory name must match the skill name to keep identity stable.
        if dir.file_name().and_then(|n| n.to_str()) != Some(meta.name.as_str()) {
            continue;
        }
        skills.push(Skill {
            meta,
            source,
            enabled: true,
            dir: Some(dir),
        });
    }
    skills
}

fn list_sidecar_files(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    for sub in ["scripts", "templates", "references", "assets"] {
        let sub_dir = dir.join(sub);
        let Ok(entries) = std::fs::read_dir(&sub_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().is_file() {
                files.push(format!("{sub}/{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLED: &str = "---\nname: bundled-demo\ndescription: bundled demo skill\norigin: bundled\n---\n\n## Steps\nbundled body\n";

    fn write_skill(root: &Path, name: &str, description: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: {description}\n---\n\n## Steps\nbody of {name}\n"
            ),
        )
        .unwrap();
    }

    fn store(data_dir: &Path) -> SkillStore {
        SkillStore::new(data_dir, vec![BundledSkill { content: BUNDLED }])
    }

    #[test]
    fn discovery_and_priority_shadowing() {
        let data = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let store = store(data.path());

        // Bundled only.
        let skills = store.discover(Some(ws.path()));
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].source, SkillSource::Bundled);

        // User skill with a new name adds; same name shadows bundled.
        write_skill(&data.path().join("skills"), "my-skill", "user skill");
        write_skill(&data.path().join("skills"), "bundled-demo", "user override");
        let skills = store.discover(Some(ws.path()));
        assert_eq!(skills.len(), 2);
        let demo = skills
            .iter()
            .find(|s| s.meta.name == "bundled-demo")
            .unwrap();
        assert_eq!(demo.source, SkillSource::User);
        assert_eq!(demo.meta.description, "user override");

        // Project skill shadows user.
        write_skill(
            &ws.path().join(".miniq/skills"),
            "my-skill",
            "project override",
        );
        let skills = store.discover(Some(ws.path()));
        let mine = skills.iter().find(|s| s.meta.name == "my-skill").unwrap();
        assert_eq!(mine.source, SkillSource::Project);
    }

    #[test]
    fn read_bundled_and_disk() {
        let data = tempfile::tempdir().unwrap();
        let store = store(data.path());
        let detail = store.read(None, "bundled-demo").unwrap();
        assert!(detail.body.contains("bundled body"));
        assert!(detail.skill_dir.is_none());

        write_skill(&data.path().join("skills"), "on-disk", "disk skill");
        std::fs::create_dir_all(data.path().join("skills/on-disk/scripts")).unwrap();
        std::fs::write(
            data.path().join("skills/on-disk/scripts/run.py"),
            "print(1)",
        )
        .unwrap();
        let detail = store.read(None, "on-disk").unwrap();
        assert!(detail.body.contains("body of on-disk"));
        assert_eq!(detail.files, vec!["scripts/run.py"]);
        assert!(detail.skill_dir.is_some());
    }

    #[test]
    fn enable_disable_persists() {
        let data = tempfile::tempdir().unwrap();
        {
            let store = store(data.path());
            store.set_enabled("bundled-demo", false).unwrap();
            assert!(!store.discover(None)[0].enabled);
        }
        // New store instance reads persisted state.
        let store = store(data.path());
        assert!(!store.discover(None)[0].enabled);
        store.set_enabled("bundled-demo", true).unwrap();
        assert!(store.discover(None)[0].enabled);
    }

    #[test]
    fn save_validates_and_delete_scopes() {
        let data = tempfile::tempdir().unwrap();
        let store = store(data.path());

        assert!(store.save("not a skill").is_err());
        let meta = store
            .save("---\nname: saved-skill\ndescription: distilled\norigin: distilled\n---\n\n## Steps\n1. do it\n")
            .unwrap();
        assert_eq!(meta.name, "saved-skill");
        assert!(store.read(None, "saved-skill").is_ok());

        // Bundled skills cannot be deleted.
        assert!(store.delete(None, "bundled-demo").is_err());
        store.delete(None, "saved-skill").unwrap();
        assert!(store.read(None, "saved-skill").is_err());
    }

    #[test]
    fn mismatched_dir_name_skipped() {
        let data = tempfile::tempdir().unwrap();
        let store = store(data.path());
        let dir = data.path().join("skills/wrong-dir");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: other-name\ndescription: mismatch\n---\nbody",
        )
        .unwrap();
        assert!(store
            .discover(None)
            .iter()
            .all(|s| s.meta.name != "other-name"));
    }
}
