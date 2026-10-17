use super::common::{params, store_err};
use crate::state::AppState;
use miniq_protocol::{ErrorCode, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf, process::Stdio};
use tokio::process::Command;

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionInput {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiffInput {
    session_id: String,
    path: String,
    #[serde(default)]
    staged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    index_status: char,
    worktree_status: char,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffStats {
    additions: u64,
    deletions: u64,
}

fn invalid(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, error.to_string())
}

fn cwd(state: &AppState, session_id: &str) -> Result<PathBuf, RpcError> {
    let session = state.store.get_session(session_id).map_err(store_err)?;
    let path = PathBuf::from(session.working_directory);
    if !path.is_dir() {
        return Err(invalid("session working directory is unavailable"));
    }
    Ok(path)
}

fn git(cwd: &PathBuf) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--literal-pathspecs")
        .args(["-c", &format!("core.hooksPath={}", null_device())])
        .args(["-c", "core.fsmonitor=false"])
        .args(["-c", "diff.external="])
        .arg("-C")
        .arg(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_EXTERNAL_DIFF")
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    command
}

#[cfg(unix)]
fn null_device() -> &'static str {
    "/dev/null"
}

#[cfg(windows)]
fn null_device() -> &'static str {
    "NUL"
}

async fn output(mut command: Command) -> Result<std::process::Output, RpcError> {
    command
        .output()
        .await
        .map_err(|error| invalid(format!("git is unavailable: {error}")))
}

fn ensure_success(output: std::process::Output) -> Result<Vec<u8>, RpcError> {
    if output.status.success() {
        return Ok(output.stdout);
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(invalid(if message.is_empty() {
        "git command failed".into()
    } else {
        message
    }))
}

fn ensure_diff(output: std::process::Output) -> Result<Vec<u8>, RpcError> {
    if output.status.success() || output.status.code() == Some(1) {
        return Ok(output.stdout);
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(invalid(if message.is_empty() {
        "git diff failed".into()
    } else {
        message
    }))
}

pub(super) async fn status(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionInput = params(raw)?;
    let cwd = cwd(state, &input.session_id)?;
    let mut command = git(&cwd);
    command.args([
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
        "--untracked-files=all",
    ]);
    let bytes = ensure_success(output(command).await?)?;
    let (branch, entries) = parse_status(&bytes)?;
    let stats = diff_stats(&cwd, &entries).await?;

    let mut root_command = git(&cwd);
    root_command.args(["rev-parse", "--show-toplevel"]);
    let root = String::from_utf8(ensure_success(output(root_command).await?)?)
        .map_err(invalid)?
        .trim()
        .to_owned();
    Ok(json!({"root": root, "branch": branch, "entries": entries, "stats": stats}))
}

async fn diff_stats(cwd: &PathBuf, entries: &[GitEntry]) -> Result<DiffStats, RpcError> {
    let mut head = git(cwd);
    head.args(["rev-parse", "--verify", "HEAD"]);
    let mut stats = if output(head).await?.status.success() {
        let mut command = git(cwd);
        command.args([
            "diff",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
        ]);
        parse_numstat(&ensure_success(output(command).await?)?)?
    } else {
        let mut staged = git(cwd);
        staged.args([
            "diff",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            "--cached",
            "--",
        ]);
        let mut stats = parse_numstat(&ensure_success(output(staged).await?)?)?;
        let mut worktree = git(cwd);
        worktree.args(["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--"]);
        stats.add(parse_numstat(&ensure_success(output(worktree).await?)?)?);
        stats
    };
    for entry in entries
        .iter()
        .filter(|entry| entry.index_status == '?' && entry.worktree_status == '?')
    {
        let mut command = git(cwd);
        command.args([
            "diff",
            "--no-index",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            null_device(),
        ]);
        command.arg(&entry.path);
        stats.add(parse_numstat(&ensure_diff(output(command).await?)?)?);
    }
    Ok(stats)
}

impl DiffStats {
    fn add(&mut self, other: Self) {
        self.additions = self.additions.saturating_add(other.additions);
        self.deletions = self.deletions.saturating_add(other.deletions);
    }
}

fn parse_numstat(bytes: &[u8]) -> Result<DiffStats, RpcError> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("git returned invalid numstat"))?;
    let mut stats = DiffStats::default();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let mut fields = line.splitn(3, '\t');
        let additions = fields
            .next()
            .ok_or_else(|| invalid("git returned invalid numstat"))?;
        let deletions = fields
            .next()
            .ok_or_else(|| invalid("git returned invalid numstat"))?;
        if additions == "-" || deletions == "-" {
            continue;
        }
        stats.additions = stats
            .additions
            .saturating_add(additions.parse::<u64>().map_err(invalid)?);
        stats.deletions = stats
            .deletions
            .saturating_add(deletions.parse::<u64>().map_err(invalid)?);
    }
    Ok(stats)
}

pub(super) async fn diff(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DiffInput = params(raw)?;
    let cwd = cwd(state, &input.session_id)?;
    let mut status_command = git(&cwd);
    status_command.args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let (_, entries) = parse_status(&ensure_success(output(status_command).await?)?)?;
    let changed: HashSet<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    if !changed.contains(input.path.as_str()) {
        return Err(invalid("path is not a changed file in this repository"));
    }

    let mut command = git(&cwd);
    let entry = entries
        .iter()
        .find(|entry| entry.path == input.path)
        .expect("validated status path");
    if entry.index_status == '?' && entry.worktree_status == '?' {
        if input.staged {
            return Err(invalid("untracked files do not have a staged diff"));
        }
        command.args([
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            null_device(),
        ]);
        command.arg(&input.path);
    } else {
        command.args(["diff", "--no-ext-diff", "--no-textconv", "--no-color"]);
        if input.staged {
            command.arg("--cached");
        }
        command.arg("--").arg(&input.path);
    }
    let bytes = ensure_diff(output(command).await?)?;
    if bytes.len() > MAX_DIFF_BYTES {
        return Err(invalid("diff exceeds 2 MiB"));
    }
    let diff = String::from_utf8(bytes).map_err(|_| invalid("binary diff is not displayable"))?;
    Ok(json!({"path": input.path, "staged": input.staged, "diff": diff}))
}

fn parse_status(bytes: &[u8]) -> Result<(Option<String>, Vec<GitEntry>), RpcError> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut branch = None;
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        let text =
            std::str::from_utf8(record).map_err(|_| invalid("git returned non-UTF-8 paths"))?;
        if let Some(header) = text.strip_prefix("## ") {
            branch = Some(header.to_owned());
            continue;
        }
        let raw = text.as_bytes();
        if raw.len() < 4 || raw[2] != b' ' {
            return Err(invalid("git returned an invalid status record"));
        }
        let index_status = raw[0] as char;
        let worktree_status = raw[1] as char;
        let path = text[3..].to_owned();
        let original_path = if matches!(index_status, 'R' | 'C') {
            Some(
                std::str::from_utf8(
                    records
                        .next()
                        .ok_or_else(|| invalid("git rename status is incomplete"))?,
                )
                .map_err(|_| invalid("git returned a non-UTF-8 rename path"))?
                .to_owned(),
            )
        } else {
            None
        };
        entries.push(GitEntry {
            path,
            original_path,
            index_status,
            worktree_status,
        });
    }
    Ok((branch, entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_changes_and_renames() {
        let (branch, entries) =
            parse_status(b"## main...origin/main\0 M src/a.rs\0R  new.rs\0old.rs\0?? note.txt\0")
                .unwrap();
        assert_eq!(branch.as_deref(), Some("main...origin/main"));
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "src/a.rs");
        assert_eq!(entries[1].original_path.as_deref(), Some("old.rs"));
        assert_eq!(entries[2].index_status, '?');
    }

    #[test]
    fn sums_text_numstat_and_ignores_binary_rows() {
        let stats = parse_numstat(b"12\t3\tsrc/a.rs\n-\t-\tlogo.png\n4\t0\tnew.txt\n").unwrap();
        assert_eq!(stats.additions, 16);
        assert_eq!(stats.deletions, 3);
    }
}
