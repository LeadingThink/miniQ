//! Workspace path containment.

use std::path::{Component, Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PathError {
    #[error("path escapes the workspace: {0}")]
    OutsideWorkspace(String),
    #[error("invalid path: {0}")]
    Invalid(String),
}

/// Resolve `requested` (absolute or workspace-relative) to an absolute path
/// guaranteed to stay inside `workspace`.
///
pub fn resolve_in_workspace(workspace: &Path, requested: &str) -> Result<PathBuf, PathError> {
    resolve_in_roots(workspace, &[workspace.to_path_buf()], requested)
}

/// Relative paths use cwd; every target must belong to an explicitly attached root.
pub fn resolve_in_roots(
    cwd: &Path,
    roots: &[PathBuf],
    requested: &str,
) -> Result<PathBuf, PathError> {
    if requested.trim().is_empty() {
        return Err(PathError::Invalid("empty path".into()));
    }
    let requested_path = Path::new(requested);
    let joined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        cwd.join(requested_path)
    };

    let resolved = canonical_target(&joined)?;
    for root in roots {
        if resolved.starts_with(canonical_target(root)?) {
            return Ok(resolved);
        }
    }
    Err(PathError::OutsideWorkspace(
        resolved.to_string_lossy().to_string(),
    ))
}

// Canonicalize the existing ancestor before normalizing a not-yet-created suffix.
// This also rejects broken links and links that escape via an intermediate parent.
fn canonical_target(path: &Path) -> Result<PathBuf, PathError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| PathError::Invalid(error.to_string()))?
            .join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::new();
    loop {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = ancestor
                    .components()
                    .next_back()
                    .ok_or_else(|| PathError::Invalid(absolute.display().to_string()))?;
                suffix.push(name.as_os_str().to_owned());
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| PathError::Invalid(absolute.display().to_string()))?;
            }
            Err(error) => return Err(PathError::Invalid(error.to_string())),
        }
    }
    let mut resolved = ancestor
        .canonicalize()
        .map_err(|error| PathError::Invalid(error.to_string()))?;
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    normalize(&resolved)
}

/// Lexically normalize a path: resolve `.` and `..`, unify separators.
fn normalize(path: &Path) -> Result<PathBuf, PathError> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR_STR),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err(PathError::Invalid(format!(
                        "path underflows root: {}",
                        path.to_string_lossy()
                    )));
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\work\proj")
        } else {
            PathBuf::from("/work/proj")
        }
    }

    #[test]
    fn relative_path_stays_inside() {
        let p = resolve_in_workspace(&ws(), "src/main.rs").unwrap();
        assert!(p.starts_with(ws()));
    }

    #[test]
    fn dotdot_escape_rejected() {
        assert!(resolve_in_workspace(&ws(), "../outside.txt").is_err());
        assert!(resolve_in_workspace(&ws(), "src/../../outside.txt").is_err());
    }

    #[test]
    fn inner_dotdot_allowed() {
        let p = resolve_in_workspace(&ws(), "src/../README.md").unwrap();
        assert_eq!(p, ws().join("README.md"));
    }

    #[test]
    fn absolute_inside_allowed() {
        let inside = ws().join("Cargo.toml");
        let p = resolve_in_workspace(&ws(), &inside.to_string_lossy()).unwrap();
        assert_eq!(p, inside);
    }

    #[test]
    fn absolute_outside_rejected() {
        let outside = if cfg!(windows) {
            r"C:\other\file"
        } else {
            "/other/file"
        };
        assert!(resolve_in_workspace(&ws(), outside).is_err());
    }

    #[test]
    fn empty_rejected() {
        assert!(resolve_in_workspace(&ws(), "  ").is_err());
    }

    #[test]
    fn attached_roots_allow_absolute_targets_and_keep_relative_cwd() {
        let primary = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let roots = vec![primary.path().to_path_buf(), extra.path().to_path_buf()];
        assert_eq!(
            resolve_in_roots(primary.path(), &roots, "new/file").unwrap(),
            primary.path().canonicalize().unwrap().join("new/file")
        );
        assert_eq!(
            resolve_in_roots(
                primary.path(),
                &roots,
                extra.path().join("new/file").to_str().unwrap()
            )
            .unwrap(),
            extra.path().canonicalize().unwrap().join("new/file")
        );
        assert!(
            resolve_in_roots(primary.path(), &roots[..1], extra.path().to_str().unwrap()).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_and_nonexistent_children_cannot_escape() {
        let primary = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), primary.path().join("link")).unwrap();
        assert!(resolve_in_workspace(primary.path(), "link/new/file").is_err());
        assert!(resolve_in_workspace(primary.path(), "link/../secret").is_err());
        std::os::unix::fs::symlink(
            outside.path().join("missing"),
            primary.path().join("broken"),
        )
        .unwrap();
        assert!(resolve_in_workspace(primary.path(), "broken/file").is_err());
        let roots = vec![primary.path().to_path_buf(), outside.path().to_path_buf()];
        assert_eq!(
            resolve_in_roots(primary.path(), &roots, "link/new").unwrap(),
            outside.path().canonicalize().unwrap().join("new")
        );
    }
}
