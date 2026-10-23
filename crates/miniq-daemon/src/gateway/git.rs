use super::common::{params, store_err};
use crate::state::AppState;
use futures_util::{stream, StreamExt, TryStreamExt};
use miniq_protocol::{ErrorCode, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf, process::Stdio};
use tokio::process::Command;

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// Untracked files each need their own `git diff --no-index`; eight at a time keeps
/// the change count off the critical path without flooding the machine.
const UNTRACKED_STATS_CONCURRENCY: usize = 8;

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
    let input: StatusInput = params(raw)?;
    let cwd = cwd(state, &input.session_id)?;
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

    let mut root_command = git(&cwd);
    root_command.args(["rev-parse", "--show-toplevel"]);
    let root = String::from_utf8(ensure_success(output(root_command).await?)?)
        .map_err(invalid)?
        .trim()
        .to_owned();
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
    // Untracked files have no diff against HEAD, so each one needs its own
    // `git diff --no-index`. Spawning them one at a time cost ~1.5 s for 112 files and
    // delayed the change badge, so fan out instead of serialising the spawns.
    let untracked = entries
        .iter()
        .filter(|entry| entry.index_status == '?' && entry.worktree_status == '?')
        .map(|entry| entry.path.clone())
        .collect::<Vec<_>>();
    let counted = stream::iter(untracked)
        .map(|path| async move {
            let stats = untracked_stats(cwd, path.clone()).await?;
            Ok::<_, RpcError>((path, stats))
        })
        .buffer_unordered(UNTRACKED_STATS_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    for (path, extra) in counted {
        stats.add(extra);
        per_file.insert(path, (extra.additions, extra.deletions));
    }
    for entry in entries.iter_mut() {
        if let Some((additions, deletions)) = per_file.get(&entry.path) {
            entry.additions = *additions;
            entry.deletions = *deletions;
        }
    }
    Ok(stats)
}

async fn untracked_stats(cwd: &PathBuf, path: String) -> Result<DiffStats, RpcError> {
    let mut command = git(cwd);
    command.args([
        "diff",
        "--no-index",
        "--numstat",
        "--no-ext-diff",
        "--no-textconv",
        null_device(),
    ]);
    command.arg(&path);
    Ok(parse_numstat_map(&ensure_diff(output(command).await?)?)?.0)
}

impl DiffStats {
    fn add(&mut self, other: Self) {
        self.additions = self.additions.saturating_add(other.additions);
        self.deletions = self.deletions.saturating_add(other.deletions);
    }
}

fn parse_numstat_map(
    bytes: &[u8],
) -> Result<(DiffStats, std::collections::HashMap<String, (u64, u64)>), RpcError> {
    let mut stats = DiffStats::default();
    let mut per_file = std::collections::HashMap::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let text =
            std::str::from_utf8(record).map_err(|_| invalid("git returned invalid numstat"))?;
        let mut fields = text.splitn(3, '\t');
        let (Some(additions), Some(deletions), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if additions == "-" || deletions == "-" {
            continue;
        }
        let additions = additions.parse::<u64>().map_err(invalid)?;
        let deletions = deletions.parse::<u64>().map_err(invalid)?;
        stats.additions = stats.additions.saturating_add(additions);
        stats.deletions = stats.deletions.saturating_add(deletions);
        per_file.insert(path.to_owned(), (additions, deletions));
    }
    Ok((stats, per_file))
}

fn parse_name_status(bytes: &[u8]) -> Result<Vec<GitEntry>, RpcError> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut entries = Vec::new();
    while let Some(status) = fields.next() {
        let status =
            std::str::from_utf8(status).map_err(|_| invalid("git returned invalid diff status"))?;
        let code = status.chars().next().unwrap_or('M');
        let first = fields
            .next()
            .ok_or_else(|| invalid("git returned incomplete diff status"))?;
        let first = String::from_utf8(first.to_vec())
            .map_err(|_| invalid("git returned non-UTF-8 paths"))?;
        // 重命名/复制记录是「旧路径、新路径」，其余只有一条路径。
        let (path, original_path) = if matches!(code, 'R' | 'C') {
            let next = fields
                .next()
                .ok_or_else(|| invalid("git returned incomplete rename status"))?;
            (
                String::from_utf8(next.to_vec())
                    .map_err(|_| invalid("git returned non-UTF-8 paths"))?,
                Some(first),
            )
        } else {
            (first, None)
        };
        entries.push(GitEntry {
            path,
            original_path,
            index_status: if matches!(code, 'R' | 'C') { 'R' } else { code },
            worktree_status: ' ',
            additions: 0,
            deletions: 0,
        });
    }
    Ok(entries)
}

pub(super) async fn diff(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: DiffInput = params(raw)?;
    let cwd = cwd(state, &input.session_id)?;
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
            additions: 0,
            deletions: 0,
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
    fn sums_numstat_and_keeps_per_file_counts() {
        let (stats, map) =
            parse_numstat_map(b"12\t3\tsrc/a.rs\0-\t-\tlogo.png\04\t0\tnew.txt\0").unwrap();
        assert_eq!(stats.additions, 16);
        assert_eq!(stats.deletions, 3);
        assert_eq!(map.get("src/a.rs"), Some(&(12, 3)));
        assert_eq!(map.get("new.txt"), Some(&(4, 0)));
        assert!(!map.contains_key("logo.png"));
    }

    #[test]
    fn parses_name_status_entries_including_renames() {
        let entries =
            parse_name_status(b"M\0src/a.rs\0R100\0old.rs\0new.rs\0D\0gone.txt\0").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "src/a.rs");
        assert_eq!(entries[0].index_status, 'M');
        assert_eq!(entries[1].original_path.as_deref(), Some("old.rs"));
        assert_eq!(entries[1].path, "new.rs");
        assert_eq!(entries[2].index_status, 'D');
    }
}
