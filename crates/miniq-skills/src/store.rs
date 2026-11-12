//! Skill discovery and storage.
//!
//! Roots in priority order (same name: higher shadows lower):
//! 1. `<workspace>/.miniq/skills/` — project skills (native, wins on conflict)
//! 2. `<workspace>/.agents/skills/` — project skills (generic harness compat, read-only)
//! 3. `<data_dir>/skills/`         — user global skills (incl. distilled)
//! 4. bundled                      — compiled into the binary
//!
//! Enabled/disabled state lives in `<data_dir>/skills-state.json`, not in
//! the SKILL.md, so toggling never rewrites user files.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use thiserror::Error;

use crate::parse::{parse_skill_md, render_skill_md, valid_name, ParseError, SkillMeta};

mod cache;
mod sidecars;
use cache::{absolute_path, ParsedSkill, SkillCache};
use sidecars::list_sidecar_files;

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
    /// Contributed by an enabled skills plugin (bundled or installed).
    Plugin,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    #[serde(flatten)]
    pub meta: SkillMeta,
    pub source: SkillSource,
    pub enabled: bool,
    pub dependencies: Vec<SkillDependencyStatus>,
    /// Directory on disk; `None` for bundled skills not yet materialized.
    #[serde(skip)]
    pub dir: Option<PathBuf>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDependencyStatus {
    pub command: String,
    pub available: bool,
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
    cache: Mutex<SkillCache>,
    /// Skill directories contributed by enabled plugins, refreshed by the
    /// daemon whenever the plugin set changes.
    plugin_dirs: Mutex<Vec<PathBuf>>,
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
            user_root: absolute_path(&data_dir.join("skills")),
            state_path,
            cache: Mutex::new(SkillCache::new(bundled)),
            plugin_dirs: Mutex::new(Vec::new()),
            disabled: Mutex::new(disabled),
        }
    }

    pub fn user_root(&self) -> &Path {
        &self.user_root
    }

    /// Replace the set of skill directories contributed by enabled plugins.
    pub fn set_plugin_skill_dirs(&self, dirs: Vec<PathBuf>) {
        let dirs = dirs.iter().map(|dir| absolute_path(dir)).collect();
        let mut current = self.plugin_dirs.lock().unwrap();
        if *current != dirs {
            *current = dirs;
            self.cache.lock().unwrap().clear_disk();
        }
    }

    /// Discover all skills visible for a workspace, applying shadowing.
    /// Invalid skill dirs are skipped (logged upstream), never fatal.
    pub fn discover(&self, workspace: Option<&Path>) -> Vec<Skill> {
        let mut by_name: HashMap<String, Skill> = HashMap::new();
        let plugins = self.plugin_dirs.lock().unwrap().clone();
        let disabled = self.disabled.lock().unwrap().clone();
        let mut cache = self.cache.lock().unwrap();

        // Lowest priority first; later inserts overwrite (shadow) earlier.
        for parsed in cache.bundled.values() {
            let skill = skill_from_parsed(parsed, SkillSource::Bundled, None, &disabled);
            by_name.insert(skill.meta.name.clone(), skill);
        }
        for dir in plugins {
            if let Some(parsed) = cache.load(&dir) {
                let skill = skill_from_parsed(&parsed, SkillSource::Plugin, Some(dir), &disabled);
                by_name.insert(skill.meta.name.clone(), skill);
            }
        }
        for (root, source) in self.roots(workspace) {
            for dir in cache.directories(&root).iter() {
                if let Some(parsed) = cache.load(dir) {
                    let skill = skill_from_parsed(&parsed, source, Some(dir.clone()), &disabled);
                    by_name.insert(skill.meta.name.clone(), skill);
                }
            }
        }

        let mut skills: Vec<Skill> = by_name.into_values().collect();
        skills.sort_by(|a, b| a.meta.name.cmp(&b.meta.name));
        skills
    }

    fn find(&self, workspace: Option<&Path>, name: &str) -> Result<Skill, StoreError> {
        let (parsed, source, dir) = self.resolve(workspace, name)?;
        Ok(skill_from_parsed(
            &parsed,
            source,
            dir,
            &self.disabled.lock().unwrap(),
        ))
    }

    /// Full detail: body + sidecar file list.
    pub fn read(&self, workspace: Option<&Path>, name: &str) -> Result<SkillDetail, StoreError> {
        let (parsed, source, dir) = self.resolve(workspace, name)?;
        let skill = skill_from_parsed(&parsed, source, dir.clone(), &self.disabled.lock().unwrap());
        Ok(SkillDetail {
            skill,
            body: parsed.body.clone(),
            files: dir.as_deref().map(list_sidecar_files).unwrap_or_default(),
            skill_dir: dir.map(|dir| dir.to_string_lossy().into_owned()),
        })
    }

    fn roots(&self, workspace: Option<&Path>) -> Vec<(PathBuf, SkillSource)> {
        let mut roots = vec![(self.user_root.clone(), SkillSource::User)];
        if let Some(workspace) = workspace {
            let workspace = absolute_path(workspace);
            for name in [".agents", ".miniq"] {
                roots.push((workspace.join(name).join("skills"), SkillSource::Project));
            }
        }
        roots
    }

    /// Directory names must equal skill names, so exact reads need only these candidates.
    fn resolve(
        &self,
        workspace: Option<&Path>,
        name: &str,
    ) -> Result<(Arc<ParsedSkill>, SkillSource, Option<PathBuf>), StoreError> {
        if !valid_name(name) {
            return Err(StoreError::NotFound(name.to_string()));
        }
        let plugins = self.plugin_dirs.lock().unwrap().clone();
        let mut cache = self.cache.lock().unwrap();
        for (root, source) in self.roots(workspace).into_iter().rev() {
            let dir = root.join(name);
            if let Some(parsed) = cache.load(&dir) {
                return Ok((parsed, source, Some(dir)));
            }
        }
        for dir in plugins.into_iter().rev() {
            if dir.file_name().and_then(|part| part.to_str()) == Some(name) {
                if let Some(parsed) = cache.load(&dir) {
                    return Ok((parsed, SkillSource::Plugin, Some(dir)));
                }
            }
        }
        cache
            .bundled
            .get(name)
            .map(|parsed| (parsed.clone(), SkillSource::Bundled, None))
            .ok_or_else(|| StoreError::NotFound(name.to_string()))
    }

    fn invalidate_user_skill(&self, name: &str) {
        self.cache.lock().unwrap().invalidate(&self.user_root, name);
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
        let target = dir.join("SKILL.md");
        // Retrying the same save is a no-op. This keeps the operation safe
        // when a client retries after a lost response and avoids creating a
        // needless history entry for identical content.
        if std::fs::read_to_string(&target)
            .map(|existing| existing == content)
            .unwrap_or(false)
        {
            self.invalidate_user_skill(&meta.name);
            return Ok(meta);
        }
        // Overwrites keep the previous file in a hidden history folder so an
        // edited or regenerated skill can be restored by hand.
        if target.is_file() {
            let history = dir.join(".history");
            std::fs::create_dir_all(&history)?;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis())
                .unwrap_or_default();
            std::fs::copy(&target, history.join(format!("SKILL.{stamp}.md")))?;
        }
        let staging = dir.join(".SKILL.md.tmp");
        std::fs::write(&staging, content)?;
        std::fs::rename(staging, target)?;
        self.invalidate_user_skill(&meta.name);
        Ok(meta)
    }

    /// Import a skill directory or a package containing child skill
    /// directories. Existing user skills are replaced atomically by name;
    /// project and bundled skills remain untouched and continue to shadow
    /// imported copies when they have the same name.
    pub fn import_directory(&self, source: &Path) -> Result<Vec<SkillMeta>, StoreError> {
        let roots = if source.join("SKILL.md").is_file() {
            vec![source.to_path_buf()]
        } else {
            let mut children = std::fs::read_dir(source)
                .map_err(StoreError::Io)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir() && path.join("SKILL.md").is_file())
                .collect::<Vec<_>>();
            children.sort();
            children
        };
        if roots.is_empty() {
            return Err(StoreError::Invalid(
                "skill package must contain SKILL.md or child skill directories".into(),
            ));
        }
        let mut validated = Vec::with_capacity(roots.len());
        let mut names = HashSet::new();
        for root in roots {
            let raw = std::fs::read_to_string(root.join("SKILL.md"))?;
            let (mut meta, body) = parse_skill_md(&raw).map_err(|e| StoreError::Parse {
                path: root.join("SKILL.md").display().to_string(),
                source: e,
            })?;
            if !names.insert(meta.name.clone()) {
                return Err(StoreError::Invalid(format!(
                    "skill package contains duplicate skill: {}",
                    meta.name
                )));
            }
            meta.origin = crate::parse::SkillOrigin::Installed;
            validated.push((root, meta, body));
        }
        let mut imported = Vec::with_capacity(validated.len());
        for (root, meta, body) in validated {
            let target = self.user_root.join(&meta.name);
            let temp = self.user_root.join(format!(".import-{}", meta.name));
            if temp.exists() {
                std::fs::remove_dir_all(&temp)?;
            }
            std::fs::create_dir_all(&self.user_root)?;
            self.invalidate_user_skill(&meta.name);
            copy_skill_tree(&root, &temp)?;
            let rendered = render_skill_md(&meta, &body);
            std::fs::write(temp.join("SKILL.md"), rendered)?;
            if target.exists() {
                std::fs::remove_dir_all(&target)?;
            }
            std::fs::rename(&temp, &target)?;
            self.invalidate_user_skill(&meta.name);
            imported.push(meta);
        }
        Ok(imported)
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
        self.invalidate_user_skill(name);
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

fn copy_skill_tree(source: &Path, target: &Path) -> Result<(), StoreError> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(StoreError::Invalid(format!(
                "skill package cannot contain symlinks: {}",
                entry.path().display()
            )));
        }
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_skill_tree(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn skill_from_parsed(
    parsed: &ParsedSkill,
    source: SkillSource,
    dir: Option<PathBuf>,
    disabled: &HashSet<String>,
) -> Skill {
    Skill {
        meta: parsed.meta.clone(),
        source,
        enabled: !disabled.contains(&parsed.meta.name),
        dependencies: dependencies(&parsed.meta.requires.bins),
        dir,
    }
}

fn dependencies(commands: &[String]) -> Vec<SkillDependencyStatus> {
    commands
        .iter()
        .map(|command| SkillDependencyStatus {
            command: command.clone(),
            available: command_available(command),
        })
        .collect()
}

fn command_available(command: &str) -> bool {
    let mut candidates = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .flat_map(|path| {
            let base = path.join(command);
            #[cfg(windows)]
            let candidates = [
                base.clone(),
                path.join(format!("{command}.exe")),
                path.join(format!("{command}.cmd")),
            ];
            #[cfg(not(windows))]
            let candidates = [base];
            candidates.into_iter()
        });
    candidates.any(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod cache_tests;
