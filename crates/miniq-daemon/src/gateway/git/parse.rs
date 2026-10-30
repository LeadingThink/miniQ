use super::{invalid, DiffStats, GitEntry};
use miniq_protocol::RpcError;

pub(super) fn parse_numstat_map(
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

pub(super) fn parse_name_status(bytes: &[u8]) -> Result<Vec<GitEntry>, RpcError> {
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

pub(super) fn parse_status(bytes: &[u8]) -> Result<(Option<String>, Vec<GitEntry>), RpcError> {
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
