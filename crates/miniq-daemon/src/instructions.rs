//! Project instruction discovery.
//!
//! Finds `AGENTS.md` files from the project root down to the working
//! directory, concatenates them root-first, and reports every contributing file
//! with its byte cost. Discovery is filesystem-only: the caller decides whether
//! the result becomes model-visible context.

use std::path::{Path, PathBuf};

/// Preferred local override, checked before `AGENTS.md` in each directory.
pub const LOCAL_FILENAME: &str = "AGENTS.override.md";
/// Default instruction filename.
pub const DEFAULT_FILENAME: &str = "AGENTS.md";
/// Default project root marker used to stop upward traversal.
pub const DEFAULT_ROOT_MARKER: &str = ".git";
/// Default byte budget, shared by every file in one turn.
pub const DEFAULT_MAX_BYTES: usize = 32_768;

/// How instructions are discovered and bounded.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionSettings {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Candidate filenames in priority order, checked per directory.
    #[serde(default = "default_filenames")]
    pub filenames: Vec<String>,
    /// Shared byte budget across every contributing file.
    #[serde(default = "default_max_bytes")]
    pub max_bytes: usize,
    /// Marker that ends upward traversal. Empty disables parent traversal.
    #[serde(default = "default_markers")]
    pub project_root_markers: Vec<String>,
}

const fn default_enabled() -> bool {
    true
}

fn default_filenames() -> Vec<String> {
    vec![LOCAL_FILENAME.to_string(), DEFAULT_FILENAME.to_string()]
}

const fn default_max_bytes() -> usize {
    DEFAULT_MAX_BYTES
}

fn default_markers() -> Vec<String> {
    vec![DEFAULT_ROOT_MARKER.to_string()]
}

impl Default for InstructionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            filenames: default_filenames(),
            max_bytes: DEFAULT_MAX_BYTES,
            project_root_markers: default_markers(),
        }
    }
}

/// One file that contributed instructions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstructionFile {
    pub path: PathBuf,
    /// Model-visible text, already truncated to the remaining budget.
    pub contents: String,
    /// Bytes read from disk before truncation.
    pub original_bytes: usize,
    pub truncated: bool,
}

impl InstructionFile {
    pub fn bytes(&self) -> usize {
        self.contents.len()
    }
}

/// Every instruction file found for one working directory.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadedInstructions {
    pub files: Vec<InstructionFile>,
    /// Byte budget these files were loaded under, quoted by the truncation
    /// marker so the model sees the same number the settings use.
    pub budget: usize,
}

impl LoadedInstructions {
    pub fn is_empty(&self) -> bool {
        self.files
            .iter()
            .all(|file| file.contents.trim().is_empty())
    }

    /// Concatenate in discovery order (project root first, cwd last) so the
    /// nearest file reads last and therefore wins on conflict.
    ///
    /// When the shared budget cut any file, the result ends with the section
    /// truncation marker so the model never treats a partial file as complete.
    /// The marker is additive: it costs a few dozen bytes beyond the budget.
    pub fn text(&self) -> String {
        let mut output = String::new();
        for file in &self.files {
            if file.contents.trim().is_empty() {
                continue;
            }
            if !output.is_empty() {
                output.push_str("\n\n");
            }
            output.push_str(file.contents.trim_end());
        }
        if self.files.iter().any(|file| file.truncated) {
            output.push_str(&miniq_agent::truncation_marker(
                miniq_agent::SectionId::ProjectInstructions,
                self.budget,
            ));
        }
        output
    }

    pub fn sources(&self) -> Vec<(String, usize, bool)> {
        self.files
            .iter()
            .map(|file| {
                (
                    file.path.to_string_lossy().into_owned(),
                    file.original_bytes,
                    file.truncated,
                )
            })
            .collect()
    }
}

/// Discover instruction files for `cwd`, bounded by `settings`.
///
/// The result never escapes the project root: when a marker is found, only the
/// directories between the root and `cwd` are probed.
pub fn load(cwd: &Path, settings: &InstructionSettings) -> LoadedInstructions {
    if !settings.enabled || settings.max_bytes == 0 || settings.filenames.is_empty() {
        return LoadedInstructions {
            files: Vec::new(),
            budget: settings.max_bytes,
        };
    }
    let directories = search_directories(cwd, &settings.project_root_markers);
    let mut remaining = settings.max_bytes;
    let mut files = Vec::new();
    for directory in directories {
        if remaining == 0 {
            break;
        }
        let Some(path) = first_existing_file(&directory, &settings.filenames) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let original_bytes = bytes.len();
        let truncated = original_bytes > remaining;
        let slice = if truncated {
            &bytes[..remaining]
        } else {
            &bytes[..]
        };
        let text = String::from_utf8_lossy(slice).into_owned();
        if text.trim().is_empty() {
            // A file truncated into pure whitespace contributes nothing, but it
            // still consumed budget; keep the accounting honest and move on.
            remaining = remaining.saturating_sub(slice.len());
            continue;
        }
        remaining = remaining.saturating_sub(slice.len());
        files.push(InstructionFile {
            path,
            contents: text,
            original_bytes,
            truncated,
        });
    }
    LoadedInstructions {
        files,
        budget: settings.max_bytes,
    }
}

/// Directories to probe, ordered project root first and `cwd` last.
fn search_directories(cwd: &Path, markers: &[String]) -> Vec<PathBuf> {
    let mut root = None;
    // An empty marker list disables parent traversal entirely.
    if !markers.is_empty() {
        let mut probe = cwd;
        loop {
            if markers.iter().any(|marker| probe.join(marker).exists()) {
                root = Some(probe.to_path_buf());
                break;
            }
            let Some(parent) = probe.parent() else {
                break;
            };
            probe = parent;
        }
    }
    match root {
        Some(root) => {
            let mut dirs: Vec<PathBuf> = Vec::new();
            let mut cursor_dir = cwd.to_path_buf();
            loop {
                dirs.push(cursor_dir.clone());
                if cursor_dir == root {
                    break;
                }
                let Some(parent) = cursor_dir.parent() else {
                    break;
                };
                cursor_dir = parent.to_path_buf();
            }
            dirs.reverse();
            dirs
        }
        // No marker: only the working directory itself is considered.
        None => vec![cwd.to_path_buf()],
    }
}

/// First regular file among `filenames` in `directory`.
///
/// Directories and special files are skipped so a stray `AGENTS.md` directory
/// never shadows a real file.
fn first_existing_file(directory: &Path, filenames: &[String]) -> Option<PathBuf> {
    for name in filenames {
        let name = name.trim();
        if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
            continue;
        }
        let candidate = directory.join(name);
        match std::fs::metadata(&candidate) {
            Ok(metadata) if metadata.is_file() => return Some(candidate),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn settings() -> InstructionSettings {
        InstructionSettings::default()
    }

    #[test]
    fn no_marker_probes_only_the_working_directory() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("AGENTS.md"), "cwd rule");
        let nested = temp.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let loaded = load(&nested, &settings());
        assert!(loaded.files.is_empty(), "must not walk into the parent");
    }

    #[test]
    fn root_marker_bounds_traversal_and_orders_root_first() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        write(&temp.path().join("AGENTS.md"), "root rule");
        write(&temp.path().join("crates/AGENTS.md"), "crate rule");
        let cwd = temp.path().join("crates/app");
        std::fs::create_dir_all(&cwd).unwrap();
        let loaded = load(&cwd, &settings());
        let paths: Vec<_> = loaded
            .files
            .iter()
            .map(|file| {
                file.path
                    .strip_prefix(temp.path())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(paths, ["AGENTS.md", "crates/AGENTS.md"]);
        assert!(
            loaded.text().find("root rule").unwrap() < loaded.text().find("crate rule").unwrap()
        );
    }

    #[test]
    fn override_file_wins_inside_one_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        write(&temp.path().join("AGENTS.md"), "base rule");
        write(&temp.path().join(LOCAL_FILENAME), "override rule");
        let loaded = load(temp.path(), &settings());
        assert_eq!(loaded.files.len(), 1);
        assert!(loaded.text().contains("override rule"));
        assert!(!loaded.text().contains("base rule"));
    }

    #[test]
    fn empty_marker_list_disables_parent_traversal() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        write(&temp.path().join("AGENTS.md"), "root rule");
        let nested = temp.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        write(&nested.join("AGENTS.md"), "nested rule");
        let mut configured = settings();
        configured.project_root_markers.clear();
        let loaded = load(&nested, &configured);
        assert_eq!(loaded.files.len(), 1);
        assert!(loaded.text().contains("nested rule"));
    }

    #[test]
    fn budget_is_shared_and_truncation_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        write(&temp.path().join("AGENTS.md"), &"a".repeat(64));
        write(&temp.path().join("crates/AGENTS.md"), &"b".repeat(64));
        let nested = temp.path().join("crates");
        let mut configured = settings();
        configured.max_bytes = 80;
        let loaded = load(&nested, &configured);
        assert_eq!(loaded.files.len(), 2);
        assert!(!loaded.files[0].truncated);
        assert!(loaded.files[1].truncated);
        assert_eq!(loaded.files[1].bytes(), 16);
    }

    #[test]
    fn zero_budget_disables_discovery() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("AGENTS.md"), "rule");
        let mut configured = settings();
        configured.max_bytes = 0;
        assert!(load(temp.path(), &configured).is_empty());
    }

    #[test]
    fn disabled_discovery_reads_nothing() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("AGENTS.md"), "rule");
        let mut configured = settings();
        configured.enabled = false;
        assert!(load(temp.path(), &configured).is_empty());
    }

    #[test]
    fn a_directory_named_agents_md_is_ignored() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("AGENTS.md")).unwrap();
        assert!(load(temp.path(), &settings()).files.is_empty());
    }

    #[test]
    fn invalid_utf8_is_read_lossily() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("AGENTS.md"), [0x41, 0xff, 0x42]).unwrap();
        let loaded = load(temp.path(), &settings());
        assert_eq!(loaded.files.len(), 1);
        assert!(loaded.text().starts_with('A'));
        assert!(loaded.text().ends_with('B'));
    }

    #[test]
    fn configured_fallback_filename_is_used_when_agents_is_absent() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("CLAUDE.md"), "fallback rule");
        let mut configured = settings();
        configured.filenames = vec!["CLAUDE.md".to_string()];
        let loaded = load(temp.path(), &configured);
        assert!(loaded.text().contains("fallback rule"));
    }

    #[test]
    fn path_like_filenames_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let mut configured = settings();
        configured.filenames = vec!["../AGENTS.md".to_string()];
        assert!(load(temp.path(), &configured).files.is_empty());
    }
}
