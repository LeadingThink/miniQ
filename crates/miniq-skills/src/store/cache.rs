//! Parsed skills and root indexes shared by discovery and exact reads.
//!
//! Metadata checks observe ordinary edits immediately. A bounded revalidation
//! interval also catches edits on filesystems that preserve coarse timestamps.
//! Only cache entries are evicted; skill contents and discovery results are not
//! truncated. The store mutex makes concurrent misses load a file only once.

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use crate::parse::{parse_skill_md, SkillMeta};

use super::BundledSkill;

const REVALIDATE_AFTER: Duration = Duration::from_secs(30);
const MAX_CACHED_FILES: usize = 4_096;
const MAX_CACHED_ROOTS: usize = 64;

pub(super) fn absolute_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(super) struct ParsedSkill {
    pub meta: SkillMeta,
    pub body: String,
}

#[derive(PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    readonly: bool,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl Fingerprint {
    fn of(metadata: Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            readonly: metadata.permissions().readonly(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

struct CachedFile {
    fingerprint: Fingerprint,
    loaded_at: Instant,
    last_used: u64,
    parsed: Option<Arc<ParsedSkill>>,
}

struct CachedRoot {
    fingerprint: Fingerprint,
    loaded_at: Instant,
    last_used: u64,
    directories: Arc<Vec<PathBuf>>,
}

pub(super) struct SkillCache {
    pub bundled: HashMap<String, Arc<ParsedSkill>>,
    files: HashMap<PathBuf, CachedFile>,
    roots: HashMap<PathBuf, CachedRoot>,
    clock: u64,
    #[cfg(test)]
    pub file_loads: usize,
    #[cfg(test)]
    pub root_scans: usize,
}

impl SkillCache {
    pub fn new(bundled: Vec<BundledSkill>) -> Self {
        let bundled = bundled
            .into_iter()
            .filter_map(|skill| parse_skill_md(skill.content).ok())
            .map(|(meta, body)| (meta.name.clone(), Arc::new(ParsedSkill { meta, body })))
            .collect();
        Self {
            bundled,
            files: HashMap::new(),
            roots: HashMap::new(),
            clock: 0,
            #[cfg(test)]
            file_loads: 0,
            #[cfg(test)]
            root_scans: 0,
        }
    }

    pub fn clear_disk(&mut self) {
        self.files.clear();
        self.roots.clear();
    }

    pub fn invalidate(&mut self, root: &Path, name: &str) {
        self.roots.remove(root);
        self.files.remove(&root.join(name).join("SKILL.md"));
    }

    pub fn directories(&mut self, root: &Path) -> Arc<Vec<PathBuf>> {
        let Ok(metadata) = std::fs::metadata(root) else {
            self.roots.remove(root);
            return Arc::default();
        };
        if !metadata.is_dir() {
            self.roots.remove(root);
            return Arc::default();
        }
        let fingerprint = Fingerprint::of(metadata);
        self.clock = self.clock.wrapping_add(1);
        if let Some(cached) = self.roots.get_mut(root) {
            if cached.fingerprint == fingerprint && cached.loaded_at.elapsed() < REVALIDATE_AFTER {
                cached.last_used = self.clock;
                return cached.directories.clone();
            }
        }
        let Ok(entries) = std::fs::read_dir(root) else {
            self.roots.remove(root);
            return Arc::default();
        };
        #[cfg(test)]
        {
            self.root_scans += 1;
        }
        let directories: Arc<Vec<PathBuf>> =
            Arc::new(entries.flatten().map(|entry| entry.path()).collect());
        self.roots.insert(
            root.to_path_buf(),
            CachedRoot {
                fingerprint,
                loaded_at: Instant::now(),
                last_used: self.clock,
                directories: Arc::clone(&directories),
            },
        );
        if self.roots.len() > MAX_CACHED_ROOTS {
            let oldest = self
                .roots
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone());
            if let Some(oldest) = oldest {
                self.roots.remove(&oldest);
            }
        }
        directories
    }

    pub fn load(&mut self, dir: &Path) -> Option<Arc<ParsedSkill>> {
        let path = dir.join("SKILL.md");
        // Preserve the store's prohibition on symlinked skill directories.
        let directory = std::fs::symlink_metadata(dir).ok();
        if !directory.is_some_and(|metadata| metadata.is_dir()) {
            self.files.remove(&path);
            return None;
        }
        let Some(fingerprint) = std::fs::metadata(&path)
            .ok()
            .filter(Metadata::is_file)
            .map(Fingerprint::of)
        else {
            self.files.remove(&path);
            return None;
        };
        self.clock = self.clock.wrapping_add(1);
        if let Some(cached) = self.files.get_mut(&path) {
            if cached.fingerprint == fingerprint && cached.loaded_at.elapsed() < REVALIDATE_AFTER {
                cached.last_used = self.clock;
                return cached.parsed.clone();
            }
        }
        #[cfg(test)]
        {
            self.file_loads += 1;
        }
        let parsed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| parse_skill_md(&raw).ok())
            .filter(|(meta, _)| {
                dir.file_name().and_then(|part| part.to_str()) == Some(meta.name.as_str())
            })
            .map(|(meta, body)| Arc::new(ParsedSkill { meta, body }));
        self.files.insert(
            path,
            CachedFile {
                fingerprint,
                loaded_at: Instant::now(),
                last_used: self.clock,
                parsed: parsed.clone(),
            },
        );
        if self.files.len() > MAX_CACHED_FILES {
            let oldest = self
                .files
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone());
            if let Some(oldest) = oldest {
                self.files.remove(&oldest);
            }
        }
        parsed
    }

    #[cfg(test)]
    pub fn expire(&mut self) {
        for cached in self.files.values_mut() {
            cached.loaded_at = Instant::now() - REVALIDATE_AFTER;
        }
        for cached in self.roots.values_mut() {
            cached.loaded_at = Instant::now() - REVALIDATE_AFTER;
        }
    }
}
