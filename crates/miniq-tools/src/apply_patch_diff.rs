//! Unified-diff application used by the provider-native patch tool.

use crate::router::ToolError;

pub(crate) fn create_content(diff: &str) -> String {
    let lines = diff.lines().collect::<Vec<_>>();
    if lines.iter().any(|line| line.starts_with('+')) {
        let mut content = lines
            .iter()
            .filter_map(|line| line.strip_prefix('+'))
            .collect::<Vec<_>>()
            .join("\n");
        if diff.ends_with('\n') {
            content.push('\n');
        }
        content
    } else {
        diff.to_string()
    }
}

#[derive(Default)]
struct Hunk {
    old: Vec<String>,
    new: Vec<String>,
    line_hint: Option<usize>,
}

pub(crate) fn apply_diff(original: &[u8], diff: &str) -> Result<String, ToolError> {
    let original = std::str::from_utf8(original)
        .map_err(|_| ToolError::ExecutionFailed("patch target is not UTF-8 text".into()))?;
    let mut hunks = Vec::new();
    let mut current: Option<Hunk> = None;
    for line in diff.lines() {
        if line.starts_with("--- ") || line.starts_with("+++ ") {
            continue;
        }
        if line.starts_with("@@") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            current = Some(Hunk {
                line_hint: parse_line_hint(line),
                ..Hunk::default()
            });
            continue;
        }
        let hunk = current.as_mut().ok_or_else(|| {
            ToolError::InvalidInput("update diff must contain at least one @@ hunk".into())
        })?;
        if let Some(value) = line.strip_prefix(' ') {
            hunk.old.push(value.to_string());
            hunk.new.push(value.to_string());
        } else if let Some(value) = line.strip_prefix('-') {
            hunk.old.push(value.to_string());
        } else if let Some(value) = line.strip_prefix('+') {
            hunk.new.push(value.to_string());
        } else if line != "\\ No newline at end of file" {
            return Err(ToolError::InvalidInput(format!(
                "invalid patch hunk line: {line}"
            )));
        }
    }
    if let Some(hunk) = current {
        hunks.push(hunk);
    }
    if hunks.is_empty() {
        return Err(ToolError::InvalidInput(
            "update diff must contain at least one @@ hunk".into(),
        ));
    }

    let final_newline = original.ends_with('\n') || diff.ends_with('\n');
    let mut lines = original.lines().map(str::to_string).collect::<Vec<_>>();
    let mut cursor = 0;
    for hunk in hunks {
        let position = find_hunk(&lines, &hunk, cursor)?;
        let old_len = hunk.old.len();
        lines.splice(position..position + old_len, hunk.new);
        cursor = position;
    }
    let mut output = lines.join("\n");
    if final_newline {
        output.push('\n');
    }
    Ok(output)
}

fn parse_line_hint(header: &str) -> Option<usize> {
    let old = header
        .split_whitespace()
        .find(|part| part.starts_with('-'))?;
    old.trim_start_matches('-')
        .split(',')
        .next()?
        .parse::<usize>()
        .ok()
        .map(|line| line.saturating_sub(1))
}

fn find_hunk(lines: &[String], hunk: &Hunk, cursor: usize) -> Result<usize, ToolError> {
    if hunk.old.is_empty() {
        return Ok(hunk.line_hint.unwrap_or(cursor).min(lines.len()));
    }
    if let Some(hint) = hunk.line_hint {
        if lines.get(hint..hint + hunk.old.len()) == Some(hunk.old.as_slice()) {
            return Ok(hint);
        }
    }
    let matches = lines
        .windows(hunk.old.len())
        .enumerate()
        .filter_map(|(index, window)| (index >= cursor && window == hunk.old).then_some(index))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [position] => Ok(*position),
        [] => Err(ToolError::ExecutionFailed(
            "patch context does not match the target file".into(),
        )),
        _ => Err(ToolError::ExecutionFailed(
            "patch context is ambiguous; include more unchanged lines".into(),
        )),
    }
}
