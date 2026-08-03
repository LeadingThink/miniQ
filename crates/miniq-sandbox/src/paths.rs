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
/// The check is purely lexical after normalization: `..` components are
/// resolved without touching the filesystem so the rule also applies to
/// files that do not exist yet.
pub fn resolve_in_workspace(workspace: &Path, requested: &str) -> Result<PathBuf, PathError> {
    if requested.trim().is_empty() {
        return Err(PathError::Invalid("empty path".into()));
    }
    let requested_path = Path::new(requested);
    let joined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        workspace.join(requested_path)
    };

    let normalized = normalize(&joined)?;
    let workspace_norm = normalize(workspace)?;

    if !normalized.starts_with(&workspace_norm) {
        return Err(PathError::OutsideWorkspace(
            normalized.to_string_lossy().to_string(),
        ));
    }
    Ok(normalized)
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
}
