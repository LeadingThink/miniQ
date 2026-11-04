//! Attachment paths and previews share the same parsing rules as completion.
use anyhow::Result;
use serde_json::{json, Value};
use std::path::Path;

pub struct Mention<'a> {
    pub start: usize,
    pub end: usize,
    pub path: &'a str,
}

pub fn mentions(text: &str) -> Vec<Mention<'_>> {
    let mut result = Vec::new();
    let mut chars = text.char_indices().peekable();
    let mut boundary = true;
    while let Some((start, ch)) = chars.next() {
        if ch != '@' || !boundary {
            boundary = ch.is_whitespace() || "([{".contains(ch);
            continue;
        }
        let from = start + 1;
        let quoted = chars
            .peek()
            .map(|(_, ch)| *ch)
            .filter(|ch| *ch == '\'' || *ch == '"');
        let from = if quoted.is_some() {
            chars.next();
            from + 1
        } else {
            from
        };
        let mut end = text.len();
        let mut token_end = end;
        for (i, c) in chars.by_ref() {
            if quoted.map_or(c.is_whitespace(), |quote| c == quote) {
                end = i;
                token_end = if quoted.is_some() {
                    i + c.len_utf8()
                } else {
                    i
                };
                break;
            }
        }
        let path = &text[from..end];
        result.push(Mention {
            start,
            end: token_end,
            path,
        });
        boundary = true;
    }
    result
}

pub fn quote(path: &str) -> String {
    if path.contains(char::is_whitespace) || path.contains('"') || path.contains('\'') {
        let quote = if path.contains('"') { '\'' } else { '"' };
        format!("@{quote}{path}{quote}")
    } else {
        format!("@{path}")
    }
}

pub fn path(text: &str, root: &Path) -> std::path::PathBuf {
    let text = text.trim();
    let text = text
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| text.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(text);
    root.join(text)
}

pub fn preview(path: &Path) -> Result<Value> {
    let bytes = std::fs::read(path)?;
    if image::guess_format(&bytes).is_ok() {
        let image = image::load_from_memory(&bytes)?;
        let preview = image.thumbnail(160, 160).to_rgb8();
        return Ok(
            json!({"image":{"width":preview.width(),"height":preview.height(),"pixels":preview.into_raw()},
            "text":format!("{} × {} pixels · o opens original", image.width(), image.height()),"path":path}),
        );
    }
    if let Ok(text) = String::from_utf8(bytes) {
        return Ok(json!({"text":crate::output::terminal_text(&text)}));
    }
    Ok(
        json!({"text":"Binary attachment · use Open in default application to view it.","path":path}),
    )
}

impl super::Repl {
    pub(super) fn preview_attachment(&mut self, path: std::path::PathBuf) {
        self.request(
            "Loading preview",
            super::jobs::Effect::Preview(path.display().to_string()),
            super::requests::Request::Preview(path),
        );
    }
}
