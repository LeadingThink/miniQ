//! Unified-diff application used by the provider-native patch tool.
//!
//! Hunks are matched line-by-line, so a diff written with LF applies to a
//! CRLF file. [`crate::line_ending::Document`] carries each line's terminator
//! through the splice and renders the file back with its original endings, so
//! applying a patch no longer converts a whole CRLF file to LF.

use crate::line_ending;
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

    let mut document = line_ending::parse(original);
    let final_newline = document.endings.last().copied().flatten().is_some()
        || diff.ends_with('\n');
    let mut cursor = 0;
    for hunk in hunks {
        let position = find_hunk(&document.lines, &hunk, cursor)?;
        let old_len = hunk.old.len();
        document.splice(position, old_len, hunk.new);
        cursor = position;
    }
    Ok(document.render(final_newline))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_lf_diff_to_crlf_target_and_keeps_crlf() {
        let original = b"one\r\ntwo\r\nthree\r\n";
        let diff = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
        let output = apply_diff(original, diff).unwrap();
        assert_eq!(output, "one\r\nTWO\r\nthree\r\n");
        // The rewrite must not touch the untouched lines' terminators.
        assert_eq!(output.matches("\r\n").count(), 3);
    }

    #[test]
    fn inserted_lines_take_the_target_preferred_ending() {
        let original = b"one\r\ntwo\r\n";
        let diff = "@@ -1,2 +1,3 @@\n one\n two\n+three\n";
        assert_eq!(apply_diff(original, diff).unwrap(), "one\r\ntwo\r\nthree\r\n");
    }

    #[test]
    fn mixed_endings_survive_an_unrelated_hunk() {
        let original = b"one\r\ntwo\rthree\nfour\r\n";
        let diff = "@@ -1,4 +1,4 @@\n one\n two\n-three\n+THREE\n four\n";
        assert_eq!(apply_diff(original, diff).unwrap(), "one\r\ntwo\rTHREE\r\nfour\r\n");
    }

    #[test]
    fn lf_target_is_unchanged_by_the_crlf_handling() {
        let original = b"one\ntwo\n";
        let diff = "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
        assert_eq!(apply_diff(original, diff).unwrap(), "one\nTWO\n");
    }

    #[test]
    fn missing_trailing_newline_is_preserved() {
        let original = b"one\r\ntwo";
        let diff = "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
        assert_eq!(apply_diff(original, diff).unwrap(), "one\r\nTWO");
    }
}
