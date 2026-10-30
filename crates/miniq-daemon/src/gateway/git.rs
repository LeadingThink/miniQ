use super::common::{params, store_err};
use crate::state::AppState;
use miniq_protocol::{ErrorCode, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf, process::Stdio};
use tokio::process::Command;

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
mod parse;
mod process;

use parse::{parse_name_status, parse_numstat_map, parse_status};
use process::{output, output_in_index};

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionInput {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusInput {
    session_id: String,
    /// 与某个分支比较；缺省表示工作区相对 HEAD。
    #[serde(default)]
    base: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiffInput {
    session_id: String,
    path: String,
    #[serde(default)]
    staged: bool,
    #[serde(default)]
    base: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    index_status: char,
    worktree_status: char,
    additions: u64,
    deletions: u64,
}

#[derive(Default, Serialize, Clone, Copy)]
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
    let input: StatusInput = params(raw)?;
    let root = root_of(&cwd(state, &input.session_id)?).await?;
    let cwd = PathBuf::from(&root);
    if let Some(base) = input.base.as_deref().filter(|value| !value.is_empty()) {
        return base_status(&cwd, base).await;
    }
    let mut command = git(&cwd);
    command.args([
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
        "--untracked-files=all",
    ]);
    let bytes = ensure_success(output(command).await?)?;
    let (branch, mut entries) = parse_status(&bytes)?;
    let stats = diff_stats(&cwd, &mut entries).await?;

    Ok(json!({"root": root, "branch": branch, "entries": entries, "stats": stats}))
}

/// 与指定分支比较：文件列表与行数都来自 `git diff <base>`。
async fn base_status(cwd: &PathBuf, base: &str) -> Result<Value, RpcError> {
    root_of(cwd).await?;
    let mut command = git(cwd);
    command.args(["diff", "--name-status", "-z", "--no-ext-diff", base, "--"]);
    let mut entries = parse_name_status(&ensure_success(output(command).await?)?)?;

    let mut counts = git(cwd);
    counts.args([
        "diff",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        base,
        "--",
    ]);
    let (stats, map) = parse_numstat_map(&ensure_success(output(counts).await?)?)?;
    for entry in &mut entries {
        if let Some((additions, deletions)) = map.get(&entry.path) {
            entry.additions = *additions;
            entry.deletions = *deletions;
        }
    }

    let root = root_of(cwd).await?;
    let branch = current_branch(cwd).await?;
    Ok(json!({"root": root, "branch": branch, "base": base, "entries": entries, "stats": stats}))
}

async fn root_of(cwd: &PathBuf) -> Result<String, RpcError> {
    let mut command = git(cwd);
    command.args(["rev-parse", "--show-toplevel"]);
    Ok(String::from_utf8(ensure_success(output(command).await?)?)
        .map_err(invalid)?
        .trim()
        .to_owned())
}

async fn current_branch(cwd: &PathBuf) -> Result<Option<String>, RpcError> {
    let mut command = git(cwd);
    command.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let output = output(command).await?;
    if !output.status.success() {
        return Ok(None);
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!name.is_empty() && name != "HEAD").then_some(name))
}

/// 分支清单：本地分支优先，附带远端跟踪分支，供“与分支比较”选择。
pub(super) async fn branches(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: SessionInput = params(raw)?;
    let cwd = cwd(state, &input.session_id)?;
    let mut command = git(&cwd);
    command.args([
        "for-each-ref",
        "--format=%(refname:short)%00%(refname)%00%(HEAD)",
        "refs/heads",
        "refs/remotes",
    ]);
    let bytes = ensure_success(output(command).await?)?;
    let mut branches = Vec::new();
    for line in String::from_utf8(bytes)
        .map_err(|_| invalid("git returned invalid refs"))?
        .lines()
    {
        let mut fields = line.split('\u{0}');
        let (Some(name), Some(full), current) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }
        branches.push(json!({
            "name": name,
            "remote": full.starts_with("refs/remotes/"),
            "current": current == Some("*"),
        }));
    }
    Ok(json!({
        "current": current_branch(&cwd).await?,
        "branches": branches,
    }))
}

async fn diff_stats(cwd: &PathBuf, entries: &mut [GitEntry]) -> Result<DiffStats, RpcError> {
    let mut head = git(cwd);
    head.args(["rev-parse", "--verify", "HEAD"]);
    let (mut stats, mut per_file) = if output(head).await?.status.success() {
        let mut command = git(cwd);
        command.args([
            "diff",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
        ]);
        parse_numstat_map(&ensure_success(output(command).await?)?)?
    } else {
        let mut staged = git(cwd);
        staged.args([
            "diff",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--cached",
            "--",
        ]);
        let (mut stats, mut map) = parse_numstat_map(&ensure_success(output(staged).await?)?)?;
        let mut worktree = git(cwd);
        worktree.args([
            "diff",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--",
        ]);
        let (extra, worktree_map) = parse_numstat_map(&ensure_success(output(worktree).await?)?)?;
        stats.add(extra);
        for (path, counts) in worktree_map {
            let slot = map.entry(path).or_insert((0, 0));
            slot.0 += counts.0;
            slot.1 += counts.1;
        }
        (stats, map)
    };
    let (extra, untracked) = untracked_stats(cwd, entries).await?;
    stats.add(extra);
    per_file.extend(untracked);
    for entry in entries.iter_mut() {
        if let Some((additions, deletions)) = per_file.get(&entry.path) {
            entry.additions = *additions;
            entry.deletions = *deletions;
        }
    }
    Ok(stats)
}

/// A private intent-to-add index lets Git count every untracked file in one diff.
/// The real index and staged contents are never touched; Git retains its normal
/// attributes, binary detection and symlink semantics.
async fn untracked_stats(
    cwd: &PathBuf,
    entries: &[GitEntry],
) -> Result<(DiffStats, std::collections::HashMap<String, (u64, u64)>), RpcError> {
    let mut paths = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| entry.index_status == '?' && entry.worktree_status == '?')
    {
        paths.extend_from_slice(entry.path.as_bytes());
        paths.push(0);
    }
    if paths.is_empty() {
        return Ok((DiffStats::default(), Default::default()));
    }
    let directory = std::sync::Arc::new(tempfile::tempdir().map_err(invalid)?);
    let index = directory.path().join("index");
    let objects = directory.path().join("objects");
    tokio::fs::create_dir(&objects).await.map_err(invalid)?;
    let mut add = git(cwd);
    add.env("GIT_INDEX_FILE", &index)
        .env("GIT_OBJECT_DIRECTORY", &objects)
        .args([
            "-c",
            "core.splitIndex=false",
            "add",
            "--intent-to-add",
            "--sparse",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]);
    ensure_success(output_in_index(add, paths, directory.clone()).await?)?;
    let mut diff = git(cwd);
    diff.env("GIT_INDEX_FILE", &index)
        .env("GIT_OBJECT_DIRECTORY", &objects)
        .args([
            "diff",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--",
        ]);
    parse_numstat_map(&ensure_success(
        output_in_index(diff, Vec::new(), directory).await?,
    )?)
}

impl DiffStats {
    fn add(&mut self, other: Self) {
        self.additions = self.additions.saturating_add(other.additions);
        self.deletions = self.deletions.saturating_add(other.deletions);
    }
}

pub(super) async fn diff(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DiffInput = params(raw)?;
    let root = root_of(&cwd(state, &input.session_id)?).await?;
    let cwd = PathBuf::from(&root);
    let base = input.base.as_deref().filter(|value| !value.is_empty());
    let mut status_command = git(&cwd);
    status_command.args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let (_, entries) = parse_status(&ensure_success(output(status_command).await?)?)?;
    let mut changed: HashSet<String> = if let Some(base) = base {
        let mut command = git(&cwd);
        command.args(["diff", "--name-only", "-z", "--no-ext-diff", base, "--"]);
        let listed = ensure_success(output(command).await?)?;
        std::str::from_utf8(&listed)
            .map_err(|_| invalid("git returned non-UTF-8 paths"))?
            .split('\u{0}')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        entries.iter().map(|entry| entry.path.clone()).collect()
    };
    if !changed.remove(&input.path) {
        return Err(invalid("path is not a changed file in this repository"));
    }

    let mut command = git(&cwd);
    let entry = entries.iter().find(|entry| entry.path == input.path);
    if let Some(base) = base {
        command.args([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            base,
            "--",
            &input.path,
        ]);
    } else if entry.is_some_and(|entry| entry.index_status == '?' && entry.worktree_status == '?') {
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
