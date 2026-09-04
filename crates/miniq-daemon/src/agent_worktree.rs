//! Git worktree lifecycle for isolated child agents.

use std::path::{Path, PathBuf};

use miniq_tools::ToolError;
use tokio::process::Command;

#[derive(Clone)]
pub(crate) struct AgentWorktree {
    pub path: PathBuf,
    pub branch: String,
    repo_root: PathBuf,
    base_commit: String,
}

pub(crate) struct FinalizeResult {
    pub retained: bool,
    pub error: Option<String>,
}

pub(crate) async fn create(workspace: &Path, agent_id: &str) -> Result<AgentWorktree, ToolError> {
    let repo_root = git_text(workspace, &["rev-parse", "--show-toplevel"]).await?;
    let repo_root = PathBuf::from(repo_root);
    let base_commit = git_text(&repo_root, &["rev-parse", "HEAD"]).await?;
    let parent = std::env::temp_dir().join("miniq-agent-worktrees");
    tokio::fs::create_dir_all(&parent)
        .await
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
    let path = parent.join(agent_id);
    if path.exists() {
        return Err(ToolError::ExecutionFailed(format!(
            "isolated worktree path already exists: {}",
            path.display()
        )));
    }
    let branch = format!("miniq-agent/{agent_id}");
    let output = Command::new("git")
        .arg("-C")
        .arg(&repo_root)
        .args(["worktree", "add", "-b"])
        .arg(&branch)
        .arg(&path)
        .arg(&base_commit)
        .output()
        .await
        .map_err(|error| ToolError::ExecutionFailed(format!("failed to start git: {error}")))?;
    if !output.status.success() {
        let _ = Command::new("git")
            .arg("-C")
            .arg(&repo_root)
            .args(["branch", "-D"])
            .arg(&branch)
            .output()
            .await;
        return Err(git_failure("create isolated worktree", &output.stderr));
    }
    Ok(AgentWorktree {
        path,
        branch,
        repo_root,
        base_commit,
    })
}

pub(crate) async fn finalize(worktree: &AgentWorktree) -> FinalizeResult {
    let status = match git_output(
        &worktree.path,
        &["status", "--porcelain", "--untracked-files=all"],
    )
    .await
    {
        Ok(output) => output,
        Err(error) => return retained_error(error),
    };
    let head = match git_text(&worktree.path, &["rev-parse", "HEAD"]).await {
        Ok(head) => head,
        Err(error) => return retained_error(error),
    };
    if !status.stdout.is_empty() || head != worktree.base_commit {
        return FinalizeResult {
            retained: true,
            error: None,
        };
    }

    let removed = Command::new("git")
        .arg("-C")
        .arg(&worktree.repo_root)
        .args(["worktree", "remove", "--force"])
        .arg(&worktree.path)
        .output()
        .await;
    match removed {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            return FinalizeResult {
                retained: true,
                error: Some(
                    git_failure("remove clean isolated worktree", &output.stderr).to_string(),
                ),
            }
        }
        Err(error) => return retained_error(ToolError::ExecutionFailed(error.to_string())),
    }

    let branch = Command::new("git")
        .arg("-C")
        .arg(&worktree.repo_root)
        .args(["branch", "-D"])
        .arg(&worktree.branch)
        .output()
        .await;
    let error = match branch {
        Ok(output) if output.status.success() => None,
        Ok(output) => {
            Some(git_failure("remove isolated worktree branch", &output.stderr).to_string())
        }
        Err(error) => Some(error.to_string()),
    };
    FinalizeResult {
        retained: false,
        error,
    }
}

async fn git_text(directory: &Path, arguments: &[&str]) -> Result<String, ToolError> {
    let output = git_output(directory, arguments).await?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn git_output(
    directory: &Path,
    arguments: &[&str],
) -> Result<std::process::Output, ToolError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .output()
        .await
        .map_err(|error| ToolError::ExecutionFailed(format!("failed to start git: {error}")))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(git_failure("run git", &output.stderr))
    }
}

fn git_failure(action: &str, stderr: &[u8]) -> ToolError {
    ToolError::ExecutionFailed(format!(
        "failed to {action}: {}",
        String::from_utf8_lossy(stderr).trim()
    ))
}

fn retained_error(error: ToolError) -> FinalizeResult {
    FinalizeResult {
        retained: true,
        error: Some(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git(directory: &Path, arguments: &[&str]) {
        let status = StdCommand::new("git")
            .arg("-C")
            .arg(directory)
            .args(arguments)
            .status()
            .unwrap();
        assert!(status.success(), "git {arguments:?} failed");
    }

    fn repository() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        git(directory.path(), &["init", "-q"]);
        git(
            directory.path(),
            &["config", "user.email", "miniq@test.invalid"],
        );
        git(directory.path(), &["config", "user.name", "miniQ Test"]);
        std::fs::write(directory.path().join("tracked.txt"), "base\n").unwrap();
        git(directory.path(), &["add", "tracked.txt"]);
        git(directory.path(), &["commit", "-qm", "initial"]);
        directory
    }

    #[tokio::test]
    async fn clean_worktree_is_removed() {
        let repository = repository();
        let worktree = create(repository.path(), &miniq_memory::new_id("agent"))
            .await
            .unwrap();
        assert!(worktree.path.is_dir());
        let result = finalize(&worktree).await;
        assert!(!result.retained, "{:?}", result.error);
        assert!(!worktree.path.exists());
    }

    #[tokio::test]
    async fn changed_worktree_is_retained_until_changes_are_removed() {
        let repository = repository();
        let worktree = create(repository.path(), &miniq_memory::new_id("agent"))
            .await
            .unwrap();
        let added = worktree.path.join("agent-change.txt");
        std::fs::write(&added, "keep me\n").unwrap();
        let retained = finalize(&worktree).await;
        assert!(retained.retained);
        assert!(worktree.path.is_dir());

        std::fs::remove_file(added).unwrap();
        let cleaned = finalize(&worktree).await;
        assert!(!cleaned.retained, "{:?}", cleaned.error);
        assert!(!worktree.path.exists());
    }
}
