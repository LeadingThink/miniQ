use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use miniq_protocol::ExternalProvider;

const SELECT_PROJECT: &str = "select a miniQ project";

pub(super) fn resolve_implicit_workspace(
    cwd: &Path,
    provider: ExternalProvider,
) -> Result<PathBuf, String> {
    resolve_with_home(cwd, provider, user_home().as_deref())
}

fn resolve_with_home(
    cwd: &Path,
    provider: ExternalProvider,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    let canonical = cwd.canonicalize().map_err(|error| {
        selection_error(&format!(
            "failed to resolve external session project directory: {error}"
        ))
    })?;
    if !canonical.is_dir() {
        return Err(selection_error(
            "external session project directory is not a directory",
        ));
    }
    if is_restricted_directory(&canonical, provider, home) {
        return Err(selection_error(
            "external session directory is not a miniQ project",
        ));
    }
    match nearest_git_marker(&canonical) {
        Some((root, marker)) => workspace_from_git_marker(root, &marker),
        None => Ok(canonical),
    }
}

fn nearest_git_marker(path: &Path) -> Option<(&Path, PathBuf)> {
    path.ancestors().find_map(|ancestor| {
        let marker = ancestor.join(".git");
        marker.exists().then_some((ancestor, marker))
    })
}

fn workspace_from_git_marker(root: &Path, marker: &Path) -> Result<PathBuf, String> {
    if marker.is_dir() {
        return Ok(root.to_path_buf());
    }
    if marker.is_file() {
        return linked_main_checkout(root, marker);
    }
    Err(selection_error("external session Git metadata is invalid"))
}

fn linked_main_checkout(worktree_root: &Path, git_file: &Path) -> Result<PathBuf, String> {
    let gitdir_value = metadata_value(git_file, Some("gitdir:"))?;
    let gitdir = metadata_path(worktree_root, &gitdir_value)
        .canonicalize()
        .map_err(|error| metadata_error("gitdir", error))?;
    let commondir_file = gitdir.join("commondir");
    let commondir_value = metadata_value(&commondir_file, None)?;
    let common_git_dir = metadata_path(&gitdir, &commondir_value)
        .canonicalize()
        .map_err(|error| metadata_error("commondir", error))?;
    if !common_git_dir.is_dir() || common_git_dir.file_name() != Some(OsStr::new(".git")) {
        return Err(selection_error(
            "external session linked worktree commondir is invalid",
        ));
    }
    common_git_dir
        .parent()
        .filter(|path| path.is_dir())
        .map(Path::to_path_buf)
        .ok_or_else(|| selection_error("external session linked worktree has no main checkout"))
}

fn metadata_value(path: &Path, prefix: Option<&str>) -> Result<String, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| metadata_error(&path.to_string_lossy(), error))?;
    let raw_value = match prefix {
        Some(prefix) => content.strip_prefix(prefix),
        None => Some(content.as_str()),
    };
    let value = raw_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| selection_error("external session Git metadata is invalid"))?;
    Ok(value.to_owned())
}

fn metadata_path(base: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

fn is_restricted_directory(path: &Path, provider: ExternalProvider, home: Option<&Path>) -> bool {
    let Some(canonical_home) = home.and_then(|path| path.canonicalize().ok()) else {
        return false;
    };
    if path == canonical_home {
        return true;
    }
    if provider != ExternalProvider::Codex {
        return false;
    }
    canonical_home
        .join("Documents")
        .join("Codex")
        .canonicalize()
        .is_ok_and(|scratch| path.starts_with(scratch))
}

fn metadata_error(context: &str, error: std::io::Error) -> String {
    selection_error(&format!(
        "failed to resolve external session Git {context}: {error}"
    ))
}

fn selection_error(reason: &str) -> String {
    format!("{reason}; {SELECT_PROJECT}")
}

#[cfg(windows)]
fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(not(windows))]
fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_git_subdirectory_maps_to_nearest_repo_root() {
        let temp = tempfile::tempdir().unwrap();
        let outer = temp.path().join("outer");
        let repo = outer.join("vendor").join("repo");
        let nested = repo.join("src").join("feature");
        std::fs::create_dir_all(outer.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&nested).unwrap();

        let resolved = resolve_with_home(&nested, ExternalProvider::Codex, None).unwrap();

        assert_eq!(resolved, repo.canonicalize().unwrap());
    }

    #[test]
    fn linked_worktree_maps_to_main_checkout_root() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let gitdir = main.join(".git").join("worktrees").join("feature");
        let worktree = temp.path().join("feature");
        let nested = worktree.join("src");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(gitdir.join("commondir"), "../..").unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}", gitdir.to_string_lossy()),
        )
        .unwrap();

        let resolved = resolve_with_home(&nested, ExternalProvider::Codex, None).unwrap();

        assert_eq!(resolved, main.canonicalize().unwrap());
    }

    #[test]
    fn home_and_codex_scratch_require_an_explicit_project() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let scratch = home.join("Documents").join("Codex").join("session");
        std::fs::create_dir_all(scratch.join(".git")).unwrap();

        let home_error =
            resolve_with_home(&home, ExternalProvider::ClaudeCode, Some(&home)).unwrap_err();
        let scratch_error =
            resolve_with_home(&scratch, ExternalProvider::Codex, Some(&home)).unwrap_err();

        assert!(home_error.contains(SELECT_PROJECT));
        assert!(scratch_error.contains(SELECT_PROJECT));
    }

    #[test]
    fn non_codex_provider_can_use_matching_directory_name() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let directory = home.join("Documents").join("Codex").join("real-project");
        std::fs::create_dir_all(&directory).unwrap();
        let expected = directory.canonicalize().unwrap();

        for provider in [ExternalProvider::ClaudeCode, ExternalProvider::OpenCode] {
            let resolved = resolve_with_home(&directory, provider, Some(&home)).unwrap();
            assert_eq!(resolved, expected);
        }
    }

    #[test]
    fn nonexistent_directory_requires_an_explicit_project() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing");

        let error = resolve_with_home(&missing, ExternalProvider::Codex, None).unwrap_err();

        assert!(error.contains(SELECT_PROJECT));
    }
}
